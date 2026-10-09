#!/usr/bin/env python3
"""Bounded, non-executing inventory of the exact javac classpath (stdlib only)."""
import argparse
import hashlib
import json
import os
import re
import signal
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

SCHEMA = "compile_api_evidence.v1"
MARKER = "COMPILE_API_EVIDENCE_V1 "
MAX_REPORT = 2 * 1024 * 1024
MAX_JAR = 128 * 1024 * 1024
MAX_CLASSES = 50000
MAX_CLASS = 4 * 1024 * 1024
PREFIXES = ("org.bukkit.", "io.papermc.", "com.destroystokyo.", "net.kyori.",
            "com.sk89q.", "net.milkbowl.", "me.clip.")
REPOSITORIES = (
    "https://repo.maven.apache.org/maven2/",
    "https://repo.papermc.io/repository/maven-public/",
    "https://hub.spigotmc.org/nexus/content/repositories/snapshots/",
    "https://maven.enginehub.org/repo/",
    "https://repo.extendedclip.com/content/repositories/placeholderapi/",
)
ALLOWED_HOSTS = {urllib.parse.urlparse(url).hostname for url in REPOSITORIES} | {"artifactory.papermc.io"}
ID = re.compile(r"^[A-Za-z0-9_.-]+$")


class EvidenceError(Exception):
    pass


class ClassReader:
    def __init__(self, data):
        self.data, self.offset = data, 0

    def read(self, size):
        end = self.offset + size
        if size < 0 or end > len(self.data):
            raise EvidenceError("class_truncated")
        result = self.data[self.offset:end]
        self.offset = end
        return result

    def number(self, size):
        return int.from_bytes(self.read(size), "big")

    def attributes(self):
        for _ in range(self.number(2)):
            self.read(2)
            self.read(self.number(4))


def class_inventory(data):
    reader = ClassReader(data)
    if reader.read(4) != b"\xca\xfe\xba\xbe":
        raise EvidenceError("class_invalid")
    reader.read(4)
    pool = [None] * reader.number(2)
    index = 1
    while index < len(pool):
        tag = reader.number(1)
        if tag == 1:
            # Modified UTF-8 is identical for Java identifiers used in this inventory.
            pool[index] = reader.read(reader.number(2)).replace(b"\xc0\x80", b"\0").decode("utf-8", "surrogatepass")
        elif tag == 7:
            pool[index] = ("class", reader.number(2))
        elif tag in (3, 4, 9, 10, 11, 12, 17, 18):
            reader.read(4)
        elif tag in (5, 6):
            reader.read(8)
            index += 1
        elif tag in (8, 16, 19, 20):
            reader.read(2)
        elif tag == 15:
            reader.read(3)
        else:
            raise EvidenceError("class_constant_invalid")
        index += 1

    def name(ref):
        if ref == 0:
            return ""
        value = pool[ref]
        if not isinstance(value, tuple) or value[0] != "class":
            raise EvidenceError("class_name_invalid")
        return pool[value[1]].replace("/", ".").replace("$", ".")

    access = reader.number(2)
    owner, parent = name(reader.number(2)), name(reader.number(2))
    interfaces = [name(reader.number(2)) for _ in range(reader.number(2))]
    fields, constants = [], []
    for _ in range(reader.number(2)):
        flags, field = reader.number(2), pool[reader.number(2)]
        reader.read(2)
        # Include all fields: conservative presence also covers inherited names.
        fields.append(field)
        if flags & 0x4000:
            constants.append(field)
        reader.attributes()
    for _ in range(reader.number(2)):
        reader.read(6)
        reader.attributes()
    reader.attributes()
    if reader.offset != len(data):
        raise EvidenceError("class_trailing_bytes")
    return {"name": owner, "superName": parent, "interfaces": interfaces,
            "fields": sorted(set(fields)), "enumConstants": sorted(set(constants)),
            "isEnum": bool(access & 0x4000)}


def scan_jar(path, release):
    if path.stat().st_size > MAX_JAR:
        raise EvidenceError("jar_too_large")
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > 100000 or len({entry.filename for entry in entries}) != len(entries):
            raise EvidenceError("jar_entries_invalid")
        manifest_entry = next((entry for entry in entries if entry.filename == "META-INF/MANIFEST.MF"), None)
        if manifest_entry and manifest_entry.file_size > 65536:
            raise EvidenceError("manifest_too_large")
        manifest = archive.read(manifest_entry).decode("utf-8", "replace") if manifest_entry else ""
        multi = bool(re.search(r"^Multi-Release:\s*true\s*$", manifest, re.I | re.M))
        selected = {}
        for entry in entries:
            filename, version = entry.filename, 0
            match = re.match(r"^META-INF/versions/(\d+)/(.*)$", filename)
            if match:
                version, filename = int(match[1]), match[2]
                if not multi or version > release:
                    continue
            if filename.startswith("META-INF/") or not filename.endswith(".class"):
                continue
            owner = filename[:-6].replace("/", ".").replace("$", ".")
            if not owner.startswith(PREFIXES):
                continue
            if entry.file_size > MAX_CLASS:
                raise EvidenceError("class_too_large")
            if owner in selected and version == selected[owner][0]:
                raise EvidenceError("class_identity_ambiguous")
            if owner not in selected or version > selected[owner][0]:
                selected[owner] = (version, entry)
        if len(selected) > MAX_CLASSES:
            raise EvidenceError("inventory_too_large")
        result = []
        for owner, (_, entry) in sorted(selected.items()):
            item = class_inventory(archive.read(entry))
            if item["name"] != owner:
                raise EvidenceError("class_name_mismatch")
            result.append(item)
        return result


class PublicRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlparse(newurl)
        if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS or parsed.username or parsed.password:
            raise EvidenceError("artifact_redirect_rejected")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def public_download_hash(url, maximum=MAX_JAR):
    opener = urllib.request.build_opener(PublicRedirects())
    request = urllib.request.Request(url, headers={"User-Agent": "Apache-Maven/3.9 compile-api-evidence/1", "Accept": "application/octet-stream"})
    with opener.open(request, timeout=4) as response:
        digest, size = hashlib.sha256(), 0
        while True:
            chunk = response.read(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > maximum:
                raise EvidenceError("artifact_too_large")
            digest.update(chunk)
        return digest.hexdigest()


def jar_identity(path, repository):
    try:
        relative = path.resolve().relative_to(repository.resolve())
    except ValueError:
        return None
    parts = relative.parts
    if len(parts) < 4:
        return None
    group, artifact, version, filename = ".".join(parts[:-3]), parts[-3], parts[-2], parts[-1]
    if not all(ID.fullmatch(value) for value in (group, artifact, version)):
        return None
    prefix = artifact + "-" + version
    if not filename.startswith(prefix) or not filename.endswith(".jar"):
        return None
    suffix = filename[len(prefix):-4]
    if suffix and (not suffix.startswith("-") or not ID.fullmatch(suffix[1:])):
        return None
    return {"groupId": group, "artifactId": artifact, "version": version,
            "classifier": suffix[1:] if suffix else "", "type": "jar"}


def resolved_versions(path, identity):
    version = identity["version"]
    if not version.endswith("-SNAPSHOT"):
        return [version]
    found = set()
    for metadata in sorted(path.parent.glob("maven-metadata-*.xml"))[:16]:
        if metadata.stat().st_size > 65536:
            continue
        try:
            root = ET.parse(metadata).getroot()
            for snapshot in root.findall("./versioning/snapshotVersions/snapshotVersion"):
                value = snapshot.findtext("value", "")
                if snapshot.findtext("extension") == "jar" and snapshot.findtext("classifier", "") == identity["classifier"] and ID.fullmatch(value):
                    found.add(value)
        except (ET.ParseError, OSError):
            continue
    return sorted(found, reverse=True)[:4]


def verify_public_artifact(path, identity, fingerprint, deadline):
    group = identity["groupId"]
    # Never certify a project/vendor namespace by inventing repository provenance.
    if not group.startswith(("io.papermc.paper", "org.spigotmc", "org.bukkit", "net.kyori", "com.sk89q", "net.milkbowl", "me.clip")):
        return None
    repositories = REPOSITORIES
    if group == "io.papermc.paper":
        repositories = (REPOSITORIES[1],)
    elif group in ("org.spigotmc", "org.bukkit"):
        repositories = (REPOSITORIES[2],)
    elif group.startswith("net.kyori"):
        repositories = (REPOSITORIES[0],)
    elif group.startswith("com.sk89q"):
        repositories = (REPOSITORIES[3], REPOSITORIES[0])
    elif group.startswith("me.clip"):
        repositories = (REPOSITORIES[4],)
    for resolved in resolved_versions(path, identity):
        filename = identity["artifactId"] + "-" + resolved + ("-" + identity["classifier"] if identity["classifier"] else "") + ".jar"
        location = group.replace(".", "/") + "/" + identity["artifactId"] + "/" + identity["version"] + "/" + filename
        for repository in repositories:
            if time.monotonic() >= deadline:
                return None
            url = repository + location
            try:
                if public_download_hash(url) == fingerprint:
                    return {"resolvedVersion": resolved, "sourceUrl": url, "publicVerified": True}
            except Exception:
                continue
    return None


def jdk_ancestors(classes, java_home):
    names = {name for item in classes for name in [item["superName"]] + item["interfaces"] if name.startswith(("java.", "javax."))}
    seen, result = set(), []
    candidates = [Path(java_home) / "jmods/java.base.jmod", Path(java_home) / "jre/lib/rt.jar", Path(java_home) / "lib/rt.jar"]
    jdk = next((path for path in candidates if path.is_file()), None)
    if not jdk:
        return result
    with zipfile.ZipFile(jdk) as archive:
        while names and len(seen) < 512:
            name = names.pop()
            if name in seen:
                continue
            seen.add(name)
            entry = ("classes/" if jdk.suffix == ".jmod" else "") + name.replace(".", "/") + ".class"
            if entry not in archive.namelist():
                continue
            item = class_inventory(archive.read(entry))
            result.append(item)
            names.update(parent for parent in [item["superName"]] + item["interfaces"] if parent.startswith(("java.", "javax.")))
    return sorted(result, key=lambda item: item["name"])


def collect(classpath, pom, release, repository, java_home, verify=verify_public_artifact):
    paths = [Path(value) for value in classpath.read_text().strip().split(os.pathsep) if value]
    if not paths or len(paths) > 128 or len(set(paths)) != len(paths):
        raise EvidenceError("classpath_invalid")
    dependencies, classes = [], []
    deadline = time.monotonic() + 30
    for path in paths:
        if not path.is_file() or path.suffix != ".jar":
            raise EvidenceError("classpath_entry_invalid")
        inventory = scan_jar(path, release)
        classes.extend(inventory)
        if len(classes) > MAX_CLASSES:
            raise EvidenceError("inventory_too_large")
        # Unknown/private artifacts contribute only public-namespace collision evidence.
        identity = jar_identity(path, repository)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        public = verify(path, identity, digest, deadline) if identity and inventory else None
        dependencies.append({**(identity or {}), "fingerprint": "sha256:" + digest,
                             "publicVerified": False, **(public or {}), "complete": True, "classes": inventory})
    return {"schemaVersion": SCHEMA, "repository": os.environ.get("GITHUB_REPOSITORY", ""),
            "headSha": os.environ.get("GITHUB_SHA", ""), "runId": int(os.environ.get("GITHUB_RUN_ID", "0")),
            "runAttempt": int(os.environ.get("GITHUB_RUN_ATTEMPT", "0")), "javaRelease": release,
            "pomHash": hashlib.sha256(pom.read_bytes()).hexdigest(), "complete": True,
            "dependencies": dependencies, "jdkClasses": jdk_ancestors(classes, java_home)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--classpath", type=Path, default=Path("target/verify.classpath"))
    parser.add_argument("--pom", type=Path, default=Path("pom.xml"))
    parser.add_argument("--java-release", type=int, required=True)
    parser.add_argument("--repository", type=Path, default=Path.home() / ".m2/repository")
    args = parser.parse_args()
    # A hung remote, ZIP bomb or malformed class can never become an empty valid inventory.
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(EvidenceError("evidence_timeout")))
    signal.alarm(45)
    try:
        report = collect(args.classpath, args.pom, args.java_release, args.repository, os.environ.get("JAVA_HOME", ""))
        serialized = json.dumps(report, separators=(",", ":"), ensure_ascii=True)
        if len(serialized.encode()) > MAX_REPORT:
            raise EvidenceError("report_too_large")
    except Exception as error:
        code = str(error) if isinstance(error, EvidenceError) else "evidence_invalid"
        serialized = json.dumps({"schemaVersion": SCHEMA, "complete": False, "reasonCode": code}, separators=(",", ":"))
    finally:
        signal.alarm(0)
    print(MARKER + serialized)
    return 0


if __name__ == "__main__":
    sys.exit(main())
