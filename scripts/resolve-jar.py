"""Controlled Actions entrypoint. Never executes classes or build scripts from input.jar."""
import base64
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from xml.sax.saxutils import escape

VERSION = "1.12.0"
TOOL_SHA256 = "1dfcfe974395734fa467ce620661c7623d05ba83670de0529b1fbd63ff548b9d"
ROOT = Path("resolve-output")


def fetch(url, headers=None, maximum=25 * 1024 * 1024):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=60) as response:
        data = response.read(maximum + 1)
        if len(data) > maximum:
            raise ValueError("download_size_limit")
        return data


def download():
    ref = os.environ["INPUT_REF"]
    if not re.fullmatch(r"[a-f0-9]{40}", ref):
        raise ValueError("invalid_input_ref")
    headers = {"Authorization": "Bearer " + os.environ["GH_READ_TOKEN"], "User-Agent": "tahai-resolve"}
    api = "https://api.github.com/repos/" + os.environ["GITHUB_REPOSITORY"]
    blob = json.loads(fetch(api + "/contents/input.jar?ref=" + ref, headers, 30 * 1024 * 1024))
    if blob.get("encoding") != "base64":
        # Contents API omits inline data for files >1 MiB. Git blob API supports the allowed 20 MiB.
        blob = json.loads(fetch(api + "/git/blobs/" + blob["sha"], headers, 30 * 1024 * 1024))
    data = base64.b64decode(blob["content"])
    if len(data) > 20 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != os.environ["INPUT_SHA"]:
        raise ValueError("input_fingerprint_mismatch")
    Path("input.jar").write_bytes(data)


def scalar(text, key):
    match = re.search(r"^" + re.escape(key) + r":\s*['\"]?([^\s'\"#]+)", text, re.M)
    return match.group(1) if match else ""


def command(args, cwd=None, timeout=300):
    try:
        if args[0] == "mvn":
            args[0] = shutil.which("mvn") or "mvn"
        process = subprocess.run(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, env={key: value for key, value in os.environ.items() if not re.search(r"TOKEN|SECRET|PASSWORD|CREDENTIAL", key, re.I)})
        return process.returncode, process.stdout.decode("utf-8", "replace")
    except subprocess.TimeoutExpired as error:
        return 124, (error.stdout or b"").decode("utf-8", "replace") + "\nprocess_timeout"


def resolve():
    ROOT.mkdir(exist_ok=True)
    report = {"decompiler": {"name": "Vineflower", "version": VERSION, "sha256": TOOL_SHA256}, "blockers": [], "baseline": {"status": "not_run"}, "removedSignatures": [], "missingClasses": [], "embeddedMetadata": []}
    result = {"files": [], "report": report, "inputSha256": hashlib.sha256(Path("input.jar").read_bytes()).hexdigest()}
    try:
        entries = []
        seen = set()
        with zipfile.ZipFile("input.jar") as jar:
            if len(jar.infolist()) > 2000 or sum(info.file_size for info in jar.infolist()) > 100 * 1024 * 1024:
                raise ValueError("archive_size_limit")
            for info in jar.infolist():
                path = PurePosixPath(info.filename)
                name = info.filename.rstrip("/")
                if path.is_absolute() or ".." in path.parts or "\\" in name or ":" in name or name.lower() in seen or ((info.external_attr >> 16) & 0o170000) == 0o120000 or info.flag_bits & 1:
                    raise ValueError("unsafe_or_duplicate_archive_path")
                seen.add(name.lower())
                if not info.is_dir():
                    entries.append((info.filename, jar.read(info)))
        values = dict(entries)
        report["manifest"] = values.get("META-INF/MANIFEST.MF", b"").decode("utf-8", "replace")
        report["classVersions"] = {name: struct.unpack(">H", data[6:8])[0] for name, data in entries if name.endswith(".class") and len(data) >= 8 and data[:4] == b"\xca\xfe\xba\xbe"}
        report["languageHints"] = [language for language, suffix in [("Kotlin", ".kotlin_module"), ("Scala", ".tasty")] if any(name.endswith(suffix) for name, _ in entries)]
        if report["languageHints"]:
            report["blockers"].append("检测到其他 JVM 语言元数据：" + ", ".join(report["languageHints"]) + "；首版不保证自动还原其编译语义")
        descriptor = values.get("plugin.yml", values.get("paper-plugin.yml", b"")).decode("utf-8", "replace")
        main = scalar(descriptor, "main")
        if not re.fullmatch(r"(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*", main):
            raise ValueError("missing_or_unsupported_main_class")
        result["mainClass"] = main
        result["projectName"] = scalar(descriptor, "name") or "ImportedPlugin"
        result["javaVersion"] = str(max([struct.unpack(">H", data[6:8])[0] - 44 for name, data in entries if name.endswith(".class") and data[:4] == b"\xca\xfe\xba\xbe"] or [21]))
        core, mc = os.environ.get("CORE_TYPE", "PAPER").upper(), os.environ["MC_VERSION"]
        if core not in ("PAPER", "SPIGOT") or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}(?:-[A-Za-z0-9.-]+)?", mc):
            raise ValueError("unsupported_core_or_version")
        report["originalDescriptor"] = descriptor
        package = main.rsplit(".", 1)[0]
        package_path = package.replace(".", "/") + "/"
        candidates = [(name, data) for name, data in entries if name.endswith(".class") and name.startswith(package_path)]
        foreign = [name for name, _ in entries if name.endswith(".class") and not name.startswith(package_path)]
        if foreign:
            report["blockers"].append("包含主包之外的类：已保留原 JAR，需补充其依赖坐标或确认源码归属")
            report["unclassifiedClasses"] = foreign
        for name, data in entries:
            if name.startswith("META-INF/maven/") and name.endswith(("pom.xml", "pom.properties")):
                report["embeddedMetadata"].append({"path": name, "content": data.decode("utf-8", "replace")})
        tool = Path("vineflower.jar").read_bytes() if Path("vineflower.jar").exists() else fetch(f"https://repo.maven.apache.org/maven2/org/vineflower/vineflower/{VERSION}/vineflower-{VERSION}.jar")
        if hashlib.sha256(tool).hexdigest() != TOOL_SHA256:
            raise ValueError("decompiler_checksum_mismatch")
        Path("vineflower.jar").write_bytes(tool)
        with zipfile.ZipFile("plugin-classes.jar", "w") as jar:
            for name, data in candidates:
                jar.writestr(name, data)
        source_dir = ROOT / "decompiled"
        source_dir.mkdir(exist_ok=True)
        code, log = command(["java", "-Xmx768m", "-jar", "vineflower.jar", "--silent=true", "--folder=true", "plugin-classes.jar", str(source_dir)])
        report["decompiler"].update({"exitCode": code, "log": log})
        source_files = []
        for path in source_dir.rglob("*.java"):
            relative = path.relative_to(source_dir).as_posix()
            source_files.append({"path": "src/main/java/" + relative, "content": path.read_text("utf-8", errors="replace")})
        restored_classes = {file["path"][14:-5] for file in source_files}
        report["missingClasses"] = [name for name, _ in candidates if "$" not in name and name[:-6] not in restored_classes]
        if code or report["missingClasses"]:
            report["blockers"].append("部分 Java 类无法反编译，请检查 missingClasses 与 decompiler.log")
        resources = []
        for name, data in entries:
            if name.endswith(".class") or name.startswith("META-INF/maven/") or name in ("META-INF/MANIFEST.MF",):
                continue
            if re.match(r"META-INF/.*\.(SF|RSA|DSA|EC)$", name, re.I) or name == "META-INF/INDEX.LIST":
                report["removedSignatures"].append(name)
                continue
            if name in ("plugin.yml", "paper-plugin.yml"):
                resources.append({"path": "src/main/resources/" + name, "content": data.decode("utf-8", "replace")})
                continue
            try:
                resources.append({"path": "src/main/resources/" + name, "content": data.decode("utf-8")})
            except UnicodeDecodeError:
                resources.append({"path": "src/main/resources/" + name, "content": base64.b64encode(data).decode("ascii"), "encoding": "base64"})
        if "plugin.yml" not in values:
            # Keep the original Paper descriptor and add a conservative compatibility descriptor.
            resources.append({"path": "src/main/resources/plugin.yml", "content": "name: " + result["projectName"] + "\nversion: 'restored'\nmain: " + main + "\napi-version: '" + (scalar(descriptor, "api-version") or "1.21") + "'\n"})
            report["blockers"].append("原插件使用 paper-plugin.yml，兼容描述文件需核对 bootstrap/loader 与依赖语义")
        artifact = "paper-api" if core == "PAPER" else "spigot-api"
        group = "io.papermc.paper" if core == "PAPER" else "org.spigotmc"
        repository = "https://repo.papermc.io/repository/maven-public/" if core == "PAPER" else "https://hub.spigotmc.org/nexus/content/repositories/snapshots/"
        dep_version = mc if "-" in mc else mc + "-R0.1-SNAPSHOT"
        pom = f'''<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>{escape(package)}</groupId><artifactId>restored-plugin</artifactId><version>1.0.0</version><properties><maven.compiler.release>{result['javaVersion']}</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties><repositories><repository><id>plugin-api</id><url>{repository}</url></repository></repositories><dependencies><dependency><groupId>{group}</groupId><artifactId>{artifact}</artifactId><version>{escape(dep_version)}</version><scope>provided</scope></dependency></dependencies><build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.14.1</version><configuration><proc>none</proc></configuration></plugin><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-jar-plugin</artifactId><version>3.4.2</version></plugin></plugins></build></project>'''
        files = [{"path": "pom.xml", "content": pom}] + source_files + resources
        result["files"] = files
        project = ROOT / "project"
        project.mkdir(exist_ok=True)
        for file in files:
            target = project / file["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(base64.b64decode(file["content"]) if file.get("encoding") else file["content"].encode("utf-8"))
        code, log = command(["mvn", "-B", "-ntp", "-Dmaven.compiler.proc=none", "-Dmaven.test.skip=true", "package"], cwd=project, timeout=300)
        report["baseline"] = {"status": "passed" if code == 0 else "failed", "exitCode": code, "log": log, "core": core, "mcVersion": mc, "javaVersion": result["javaVersion"]}
        if code:
            report["blockers"].append("基线编译未通过，请补充依赖或修正反编译结果")
        if len(json.dumps(files).encode()) > 12 * 1024 * 1024:
            raise ValueError("editable_project_exceeds_12MiB")
    except Exception as error:
        report["blockers"].append(str(error))
        report["fatal"] = True
    (ROOT / "resolved-project.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("download", "resolve"):
        raise SystemExit("usage: resolve-jar.py download|resolve")
    download() if sys.argv[1] == "download" else resolve()
