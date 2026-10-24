import * as monaco from "monaco-editor";
import {reactive} from "vue";
import {useIDEStore} from "./useIDEStore";
import type {DictClass as JarDictClass} from "./useJarSymbols";

type Member = {
    name: string;
    kind: "method" | "field" | "constant";
    signature: string;
    desc?: string;
    insertText?: string;
};

type DictClass = {
    name: string;
    package: string;
    kind: "class" | "interface" | "annotation" | "enum";
    desc?: string;
    members: Member[];
};

const DICT: DictClass[] = [
    {
        name: "Player", package: "org.bukkit.entity", kind: "interface", desc: "在线玩家",
        members: [
            {name: "isOp", kind: "method", signature: "boolean isOp()", desc: "是否为 OP", insertText: "isOp()"},
            {name: "hasPermission", kind: "method", signature: "boolean hasPermission(String permission)", desc: "检查权限", insertText: "hasPermission(\"${1:permission}\")"},
            {name: "sendMessage", kind: "method", signature: "void sendMessage(String message)", desc: "发送消息", insertText: "sendMessage(${1:message})"},
            {name: "getName", kind: "method", signature: "String getName()", insertText: "getName()"},
            {name: "getDisplayName", kind: "method", signature: "String getDisplayName()", insertText: "getDisplayName()"},
            {name: "getUniqueId", kind: "method", signature: "UUID getUniqueId()", insertText: "getUniqueId()"},
            {name: "getInventory", kind: "method", signature: "PlayerInventory getInventory()", insertText: "getInventory()"},
            {name: "getLocation", kind: "method", signature: "Location getLocation()", insertText: "getLocation()"},
            {name: "getWorld", kind: "method", signature: "World getWorld()", insertText: "getWorld()"},
            {name: "teleport", kind: "method", signature: "boolean teleport(Location location)", insertText: "teleport(${1:location})"},
            {name: "getHealth", kind: "method", signature: "double getHealth()", insertText: "getHealth()"},
            {name: "setHealth", kind: "method", signature: "void setHealth(double health)", insertText: "setHealth(${1:health})"},
            {name: "getFoodLevel", kind: "method", signature: "int getFoodLevel()", insertText: "getFoodLevel()"},
            {name: "setFoodLevel", kind: "method", signature: "void setFoodLevel(int value)", insertText: "setFoodLevel(${1:value})"},
            {name: "getGameMode", kind: "method", signature: "GameMode getGameMode()", insertText: "getGameMode()"},
            {name: "setGameMode", kind: "method", signature: "void setGameMode(GameMode mode)", insertText: "setGameMode(${1:GameMode.SURVIVAL})"},
            {name: "kickPlayer", kind: "method", signature: "void kickPlayer(String message)", desc: "踢出玩家", insertText: "kickPlayer(${1:message})"},
            {name: "giveExp", kind: "method", signature: "void giveExp(int amount)", insertText: "giveExp(${1:amount})"},
            {name: "playSound", kind: "method", signature: "void playSound(Location loc, Sound sound, float volume, float pitch)", insertText: "playSound(${1:loc}, ${2:sound}, ${3:1.0f}, ${4:1.0f})"},
            {name: "sendTitle", kind: "method", signature: "void sendTitle(String title, String subtitle, int fadeIn, int stay, int fadeOut)", insertText: "sendTitle(${1:title}, ${2:subtitle}, ${3:10}, ${4:40}, ${5:10})"},
            {name: "sendActionBar", kind: "method", signature: "void sendActionBar(String message)", insertText: "sendActionBar(${1:message})"},
            {name: "isOnline", kind: "method", signature: "boolean isOnline()", insertText: "isOnline()"},
            {name: "isSneaking", kind: "method", signature: "boolean isSneaking()", insertText: "isSneaking()"},
            {name: "isFlying", kind: "method", signature: "boolean isFlying()", insertText: "isFlying()"},
            {name: "setAllowFlight", kind: "method", signature: "void setAllowFlight(boolean flight)", insertText: "setAllowFlight(${1:true})"},
        ],
    },
    {
        name: "Bukkit", package: "org.bukkit", kind: "class", desc: "服务器静态门面",
        members: [
            {name: "getServer", kind: "method", signature: "Server getServer()", insertText: "getServer()"},
            {name: "getOnlinePlayers", kind: "method", signature: "Collection<? extends Player> getOnlinePlayers()", desc: "在线玩家集合", insertText: "getOnlinePlayers()"},
            {name: "getPlayer", kind: "method", signature: "Player getPlayer(String name)", insertText: "getPlayer(${1:name})"},
            {name: "getPlayerExact", kind: "method", signature: "Player getPlayerExact(String name)", insertText: "getPlayerExact(${1:name})"},
            {name: "getOfflinePlayer", kind: "method", signature: "OfflinePlayer getOfflinePlayer(String name)", insertText: "getOfflinePlayer(${1:name})"},
            {name: "getWorld", kind: "method", signature: "World getWorld(String name)", insertText: "getWorld(${1:name})"},
            {name: "getWorlds", kind: "method", signature: "List<World> getWorlds()", insertText: "getWorlds()"},
            {name: "getPluginManager", kind: "method", signature: "PluginManager getPluginManager()", insertText: "getPluginManager()"},
            {name: "getScheduler", kind: "method", signature: "BukkitScheduler getScheduler()", insertText: "getScheduler()"},
            {name: "broadcastMessage", kind: "method", signature: "int broadcastMessage(String message)", insertText: "broadcastMessage(${1:message})"},
            {name: "dispatchCommand", kind: "method", signature: "boolean dispatchCommand(CommandSender sender, String command)", insertText: "dispatchCommand(${1:sender}, ${2:command})"},
            {name: "getLogger", kind: "method", signature: "Logger getLogger()", insertText: "getLogger()"},
            {name: "getConsoleSender", kind: "method", signature: "ConsoleCommandSender getConsoleSender()", insertText: "getConsoleSender()"},
        ],
    },
    {
        name: "JavaPlugin", package: "org.bukkit.plugin.java", kind: "class", desc: "插件主类基类",
        members: [
            {name: "onEnable", kind: "method", signature: "void onEnable()", desc: "插件启用回调"},
            {name: "onDisable", kind: "method", signature: "void onDisable()", desc: "插件禁用回调"},
            {name: "onLoad", kind: "method", signature: "void onLoad()"},
            {name: "getLogger", kind: "method", signature: "Logger getLogger()", insertText: "getLogger()"},
            {name: "getConfig", kind: "method", signature: "FileConfiguration getConfig()", insertText: "getConfig()"},
            {name: "saveConfig", kind: "method", signature: "void saveConfig()", insertText: "saveConfig()"},
            {name: "reloadConfig", kind: "method", signature: "void reloadConfig()", insertText: "reloadConfig()"},
            {name: "saveDefaultConfig", kind: "method", signature: "void saveDefaultConfig()", insertText: "saveDefaultConfig()"},
            {name: "getCommand", kind: "method", signature: "PluginCommand getCommand(String name)", insertText: "getCommand(${1:name})"},
            {name: "getServer", kind: "method", signature: "Server getServer()", insertText: "getServer()"},
            {name: "getDataFolder", kind: "method", signature: "File getDataFolder()", insertText: "getDataFolder()"},
            {name: "getResource", kind: "method", signature: "InputStream getResource(String filename)", insertText: "getResource(${1:filename})"},
            {name: "saveResource", kind: "method", signature: "void saveResource(String resourcePath, boolean replace)", insertText: "saveResource(${1:path}, ${2:false})"},
        ],
    },
    {
        name: "World", package: "org.bukkit", kind: "interface",
        members: [
            {name: "getName", kind: "method", signature: "String getName()", insertText: "getName()"},
            {name: "getPlayers", kind: "method", signature: "List<Player> getPlayers()", insertText: "getPlayers()"},
            {name: "getSpawnLocation", kind: "method", signature: "Location getSpawnLocation()", insertText: "getSpawnLocation()"},
            {name: "getBlockAt", kind: "method", signature: "Block getBlockAt(Location location)", insertText: "getBlockAt(${1:location})"},
            {name: "dropItem", kind: "method", signature: "Item dropItem(Location location, ItemStack item)", insertText: "dropItem(${1:location}, ${2:item})"},
            {name: "dropItemNaturally", kind: "method", signature: "Item dropItemNaturally(Location location, ItemStack item)", insertText: "dropItemNaturally(${1:location}, ${2:item})"},
            {name: "spawnEntity", kind: "method", signature: "Entity spawnEntity(Location loc, EntityType type)", insertText: "spawnEntity(${1:loc}, ${2:type})"},
            {name: "strikeLightning", kind: "method", signature: "LightningStrike strikeLightning(Location loc)", insertText: "strikeLightning(${1:loc})"},
            {name: "playSound", kind: "method", signature: "void playSound(Location loc, Sound sound, float volume, float pitch)", insertText: "playSound(${1:loc}, ${2:sound}, ${3:1.0f}, ${4:1.0f})"},
            {name: "setTime", kind: "method", signature: "void setTime(long time)", insertText: "setTime(${1:time})"},
            {name: "getTime", kind: "method", signature: "long getTime()", insertText: "getTime()"},
        ],
    },
    {
        name: "Block", package: "org.bukkit.block", kind: "interface",
        members: [
            {name: "getType", kind: "method", signature: "Material getType()", insertText: "getType()"},
            {name: "setType", kind: "method", signature: "void setType(Material material)", insertText: "setType(${1:material})"},
            {name: "getLocation", kind: "method", signature: "Location getLocation()", insertText: "getLocation()"},
            {name: "breakNaturally", kind: "method", signature: "boolean breakNaturally()", insertText: "breakNaturally()"},
            {name: "getWorld", kind: "method", signature: "World getWorld()", insertText: "getWorld()"},
            {name: "getX", kind: "method", signature: "int getX()", insertText: "getX()"},
            {name: "getY", kind: "method", signature: "int getY()", insertText: "getY()"},
            {name: "getZ", kind: "method", signature: "int getZ()", insertText: "getZ()"},
        ],
    },
    {
        name: "ItemStack", package: "org.bukkit.inventory", kind: "class",
        members: [
            {name: "getType", kind: "method", signature: "Material getType()", insertText: "getType()"},
            {name: "setType", kind: "method", signature: "void setType(Material type)", insertText: "setType(${1:material})"},
            {name: "getAmount", kind: "method", signature: "int getAmount()", insertText: "getAmount()"},
            {name: "setAmount", kind: "method", signature: "void setAmount(int amount)", insertText: "setAmount(${1:amount})"},
            {name: "getItemMeta", kind: "method", signature: "ItemMeta getItemMeta()", insertText: "getItemMeta()"},
            {name: "setItemMeta", kind: "method", signature: "boolean setItemMeta(ItemMeta itemMeta)", insertText: "setItemMeta(${1:meta})"},
            {name: "addEnchantment", kind: "method", signature: "void addEnchantment(Enchantment ench, int level)", insertText: "addEnchantment(${1:ench}, ${2:level})"},
        ],
    },
    {
        name: "Location", package: "org.bukkit", kind: "class",
        members: [
            {name: "getWorld", kind: "method", signature: "World getWorld()", insertText: "getWorld()"},
            {name: "getX", kind: "method", signature: "double getX()", insertText: "getX()"},
            {name: "getY", kind: "method", signature: "double getY()", insertText: "getY()"},
            {name: "getZ", kind: "method", signature: "double getZ()", insertText: "getZ()"},
            {name: "getYaw", kind: "method", signature: "float getYaw()", insertText: "getYaw()"},
            {name: "getPitch", kind: "method", signature: "float getPitch()", insertText: "getPitch()"},
            {name: "getBlock", kind: "method", signature: "Block getBlock()", insertText: "getBlock()"},
            {name: "add", kind: "method", signature: "Location add(double x, double y, double z)", insertText: "add(${1:x}, ${2:y}, ${3:z})"},
            {name: "distance", kind: "method", signature: "double distance(Location other)", insertText: "distance(${1:other})"},
        ],
    },
    {
        name: "CommandSender", package: "org.bukkit.command", kind: "interface",
        members: [
            {name: "sendMessage", kind: "method", signature: "void sendMessage(String message)", insertText: "sendMessage(${1:message})"},
            {name: "hasPermission", kind: "method", signature: "boolean hasPermission(String permission)", insertText: "hasPermission(\"${1:permission}\")"},
            {name: "getName", kind: "method", signature: "String getName()", insertText: "getName()"},
            {name: "isOp", kind: "method", signature: "boolean isOp()", insertText: "isOp()"},
        ],
    },
    {
        name: "FileConfiguration", package: "org.bukkit.configuration.file", kind: "class",
        members: [
            {name: "getString", kind: "method", signature: "String getString(String path)", insertText: "getString(\"${1:path}\")"},
            {name: "getInt", kind: "method", signature: "int getInt(String path)", insertText: "getInt(\"${1:path}\")"},
            {name: "getBoolean", kind: "method", signature: "boolean getBoolean(String path)", insertText: "getBoolean(\"${1:path}\")"},
            {name: "getDouble", kind: "method", signature: "double getDouble(String path)", insertText: "getDouble(\"${1:path}\")"},
            {name: "getStringList", kind: "method", signature: "List<String> getStringList(String path)", insertText: "getStringList(\"${1:path}\")"},
            {name: "set", kind: "method", signature: "void set(String path, Object value)", insertText: "set(\"${1:path}\", ${2:value})"},
            {name: "contains", kind: "method", signature: "boolean contains(String path)", insertText: "contains(\"${1:path}\")"},
        ],
    },
    {
        name: "ChatColor", package: "org.bukkit", kind: "enum", desc: "聊天颜色枚举",
        members: [
            {name: "BLACK", kind: "constant", signature: "§0"},
            {name: "DARK_BLUE", kind: "constant", signature: "§1"},
            {name: "DARK_GREEN", kind: "constant", signature: "§2"},
            {name: "DARK_AQUA", kind: "constant", signature: "§3"},
            {name: "DARK_RED", kind: "constant", signature: "§4"},
            {name: "DARK_PURPLE", kind: "constant", signature: "§5"},
            {name: "GOLD", kind: "constant", signature: "§6"},
            {name: "GRAY", kind: "constant", signature: "§7"},
            {name: "DARK_GRAY", kind: "constant", signature: "§8"},
            {name: "BLUE", kind: "constant", signature: "§9"},
            {name: "GREEN", kind: "constant", signature: "§a"},
            {name: "AQUA", kind: "constant", signature: "§b"},
            {name: "RED", kind: "constant", signature: "§c"},
            {name: "LIGHT_PURPLE", kind: "constant", signature: "§d"},
            {name: "YELLOW", kind: "constant", signature: "§e"},
            {name: "WHITE", kind: "constant", signature: "§f"},
            {name: "BOLD", kind: "constant", signature: "§l"},
            {name: "ITALIC", kind: "constant", signature: "§o"},
            {name: "UNDERLINE", kind: "constant", signature: "§n"},
            {name: "STRIKETHROUGH", kind: "constant", signature: "§m"},
            {name: "RESET", kind: "constant", signature: "§r"},
            {name: "translateAlternateColorCodes", kind: "method", signature: "String translateAlternateColorCodes(char altColorChar, String text)", desc: "& → §", insertText: "translateAlternateColorCodes('&', ${1:text})"},
            {name: "stripColor", kind: "method", signature: "String stripColor(String input)", insertText: "stripColor(${1:input})"},
        ],
    },
    {
        name: "PlayerJoinEvent", package: "org.bukkit.event.player", kind: "class",
        members: [
            {name: "getPlayer", kind: "method", signature: "Player getPlayer()", insertText: "getPlayer()"},
            {name: "getJoinMessage", kind: "method", signature: "String getJoinMessage()", insertText: "getJoinMessage()"},
            {name: "setJoinMessage", kind: "method", signature: "void setJoinMessage(String message)", insertText: "setJoinMessage(${1:message})"},
        ],
    },
    {
        name: "PlayerQuitEvent", package: "org.bukkit.event.player", kind: "class",
        members: [
            {name: "getPlayer", kind: "method", signature: "Player getPlayer()", insertText: "getPlayer()"},
            {name: "getQuitMessage", kind: "method", signature: "String getQuitMessage()", insertText: "getQuitMessage()"},
            {name: "setQuitMessage", kind: "method", signature: "void setQuitMessage(String message)", insertText: "setQuitMessage(${1:message})"},
        ],
    },
    {
        name: "BlockBreakEvent", package: "org.bukkit.event.block", kind: "class",
        members: [
            {name: "getBlock", kind: "method", signature: "Block getBlock()", insertText: "getBlock()"},
            {name: "getPlayer", kind: "method", signature: "Player getPlayer()", insertText: "getPlayer()"},
            {name: "setCancelled", kind: "method", signature: "void setCancelled(boolean cancel)", insertText: "setCancelled(${1:true})"},
            {name: "isCancelled", kind: "method", signature: "boolean isCancelled()", insertText: "isCancelled()"},
            {name: "setDropItems", kind: "method", signature: "void setDropItems(boolean drop)", insertText: "setDropItems(${1:false})"},
        ],
    },
    {
        name: "PlayerInteractEvent", package: "org.bukkit.event.player", kind: "class",
        members: [
            {name: "getPlayer", kind: "method", signature: "Player getPlayer()", insertText: "getPlayer()"},
            {name: "getAction", kind: "method", signature: "Action getAction()", insertText: "getAction()"},
            {name: "getItem", kind: "method", signature: "ItemStack getItem()", insertText: "getItem()"},
            {name: "getClickedBlock", kind: "method", signature: "Block getClickedBlock()", insertText: "getClickedBlock()"},
            {name: "setCancelled", kind: "method", signature: "void setCancelled(boolean cancel)", insertText: "setCancelled(${1:true})"},
        ],
    },
    {
        name: "BukkitScheduler", package: "org.bukkit.scheduler", kind: "interface",
        members: [
            {name: "runTask", kind: "method", signature: "BukkitTask runTask(Plugin plugin, Runnable task)", insertText: "runTask(${1:plugin}, ${2:task})"},
            {name: "runTaskLater", kind: "method", signature: "BukkitTask runTaskLater(Plugin plugin, Runnable task, long delay)", insertText: "runTaskLater(${1:plugin}, ${2:task}, ${3:20L})"},
            {name: "runTaskTimer", kind: "method", signature: "BukkitTask runTaskTimer(Plugin plugin, Runnable task, long delay, long period)", insertText: "runTaskTimer(${1:plugin}, ${2:task}, ${3:0L}, ${4:20L})"},
            {name: "runTaskAsynchronously", kind: "method", signature: "BukkitTask runTaskAsynchronously(Plugin plugin, Runnable task)", insertText: "runTaskAsynchronously(${1:plugin}, ${2:task})"},
            {name: "cancelTasks", kind: "method", signature: "void cancelTasks(Plugin plugin)", insertText: "cancelTasks(${1:plugin})"},
        ],
    },
    {
        name: "Listener", package: "org.bukkit.event", kind: "interface", members: [],
    },
    {
        name: "EventHandler", package: "org.bukkit.event", kind: "annotation", desc: "事件处理注解",
        members: [
            {name: "priority", kind: "field", signature: "EventPriority priority() default EventPriority.NORMAL"},
            {name: "ignoreCancelled", kind: "field", signature: "boolean ignoreCancelled() default false"},
        ],
    },
    {name: "Override", package: "java.lang", kind: "annotation", desc: "重写父类方法", members: []},
    {name: "Deprecated", package: "java.lang", kind: "annotation", desc: "标记为已废弃", members: []},
    {name: "SuppressWarnings", package: "java.lang", kind: "annotation", desc: "压制编译警告", members: []},
    {name: "Nullable", package: "org.jetbrains.annotations", kind: "annotation", desc: "可为 null", members: []},
    {name: "NotNull", package: "org.jetbrains.annotations", kind: "annotation", desc: "不可为 null", members: []},
];

// ─── 动态字典管理（来自 pom + JAR）─────────────────────────────

const dynamicState = reactive<{
    classes: JarDictClass[];
    byName: Map<string, JarDictClass>;
    annotations: JarDictClass[];
    loaded: boolean;
}>({
    classes: [],
    byName: new Map(),
    annotations: [],
    loaded: false,
});

export function setDynamicDict(classes: JarDictClass[]) {
    dynamicState.classes = classes;
    const m = new Map<string, JarDictClass>();
    const ann: JarDictClass[] = [];
    for (const c of classes) {
        const prev = m.get(c.name);
        // 同名优先 org.bukkit.* / io.papermc.*
        if (!prev || preferPackage(c.package, prev.package)) m.set(c.name, c);
        if (c.kind === "annotation") ann.push(c);
    }
    dynamicState.byName = m;
    dynamicState.annotations = ann;
    dynamicState.loaded = true;
}

function preferPackage(a: string, b: string): boolean {
    const score = (p: string) =>
        p.startsWith("org.bukkit") ? 3 :
        p.startsWith("io.papermc") || p.startsWith("com.destroystokyo.paper") ? 3 :
        p.startsWith("org.spigotmc") ? 2 :
        p.startsWith("java.") || p.startsWith("javax.") ? 1 : 0;
    return score(a) > score(b);
}

export function getDynamicDictStatus() {
    return dynamicState;
}

// ─── 合并索引：硬编码 + 动态 ────────────────────────────────

const HARDCODED_INDEX = new Map(DICT.map(c => [c.name, c]));

type ResolvedClass = {
    name: string;
    package: string;
    kind: "class" | "interface" | "annotation" | "enum";
    desc?: string;
    members: Member[];
};

// 合并动态 + 硬编码：union by member name，硬编码版本优先（含手工 snippet）
function lookupClass(name: string): ResolvedClass | undefined {
    const dyn = dynamicState.byName.get(name);
    const hard = HARDCODED_INDEX.get(name);
    if (!dyn && !hard) return undefined;
    if (!dyn) return hard as ResolvedClass;
    if (!hard) {
        return {
            name: dyn.name,
            package: dyn.package,
            kind: dyn.kind,
            members: dyn.members as Member[],
        };
    }
    const byName = new Map<string, Member>();
    for (const m of dyn.members as Member[]) byName.set(m.name, m);
    for (const m of hard.members) byName.set(m.name, m);
    return {
        name: hard.name,
        package: hard.package,
        kind: hard.kind,
        desc: hard.desc,
        members: Array.from(byName.values()),
    };
}

// 给方法补强 insertText：缺失或只是 name 时强制加 ()
function ensureCallable(m: Member): { text: string; isSnippet: boolean } {
    let t = m.insertText;
    if (!t || t === m.name) {
        if (m.kind === "method") t = m.name + "()";
        else t = m.name;
    }
    return {text: t, isSnippet: t.includes("${")};
}

// 扫描当前文件，把"类型 变量名"对应起来：Player p; List<String> names;
function scanLocalTypes(content: string): Map<string, string> {
    const types = new Map<string, string>();
    const re = /(?:^|[\s,(])([A-Z]\w+)(?:<[^>]+>)?(?:\[\])*\s+([a-z]\w*)\s*(?:[=;)]|,(?!\s*$))/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        if (!types.has(m[2])) types.set(m[2], m[1]);
    }
    return types;
}

function kindToMonaco(k: Member["kind"] | DictClass["kind"]): monaco.languages.CompletionItemKind {
    switch (k) {
        case "class": return monaco.languages.CompletionItemKind.Class;
        case "interface": return monaco.languages.CompletionItemKind.Interface;
        case "enum": return monaco.languages.CompletionItemKind.Enum;
        case "annotation": return monaco.languages.CompletionItemKind.Constant;
        case "method": return monaco.languages.CompletionItemKind.Method;
        case "field": return monaco.languages.CompletionItemKind.Field;
        case "constant": return monaco.languages.CompletionItemKind.EnumMember;
        default: return monaco.languages.CompletionItemKind.Text;
    }
}

let registered = false;

export function registerBukkitCompletion() {
    if (registered) return;
    registered = true;

    monaco.languages.registerCompletionItemProvider("java", {
        triggerCharacters: [".", "@"],
        provideCompletionItems(model, position) {
            const line = model.getLineContent(position.lineNumber);
            const before = line.substring(0, position.column - 1);

            // 1. 注解 @XYZ —— 显式算 range：替换 @ 后面的部分词
            const atMatch = before.match(/@(\w*)$/);
            if (atMatch) {
                const filterText = atMatch[1];
                const atCol = position.column - atMatch[0].length;  // @ 所在列(1-indexed)
                const wordStartCol = atCol + 1;                      // @ 后第一个字符位置
                const range = new monaco.Range(
                    position.lineNumber, wordStartCol,
                    position.lineNumber, position.column,
                );
                const fromHard = DICT.filter(c => c.kind === "annotation");
                const fromDyn = dynamicState.annotations;
                const seen = new Set<string>();
                const merged = [...fromHard, ...fromDyn].filter(c => {
                    if (seen.has(c.name)) return false;
                    seen.add(c.name);
                    return true;
                });
                return {
                    suggestions: merged.map(c => ({
                        label: {label: "@" + c.name, description: c.package},
                        kind: monaco.languages.CompletionItemKind.Interface,
                        insertText: c.name,
                        filterText: c.name,
                        detail: `@${c.name}  ${c.package}`,
                        documentation: ("desc" in c && c.desc) ? {value: c.desc} : undefined,
                        range,
                        sortText: "0" + c.name,
                        preselect: c.name.toLowerCase().startsWith(filterText.toLowerCase()),
                    })),
                };
            }

            // 2. 成员访问 xxx.YYY —— 显式算 range：替换 . 后面的部分词
            const dot = before.match(/(\w+)\s*\.\s*(\w*)$/);
            if (dot) {
                const recv = dot[1];
                const filterText = dot[2] || "";
                const wordStartCol = position.column - filterText.length;
                const range = new monaco.Range(
                    position.lineNumber, wordStartCol,
                    position.lineNumber, position.column,
                );
                const locals = scanLocalTypes(model.getValue());
                const inferred = locals.get(recv) || (recv[0] === recv[0].toUpperCase() ? recv : recv[0].toUpperCase() + recv.slice(1));
                const cls = lookupClass(inferred);
                if (!cls) return {suggestions: []};

                return {
                    suggestions: cls.members.map(m => {
                        const {text, isSnippet} = ensureCallable(m);
                        return {
                            label: {label: m.name, description: m.signature},
                            kind: kindToMonaco(m.kind),
                            insertText: text,
                            insertTextRules: isSnippet
                                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                                : monaco.languages.CompletionItemInsertTextRule.None,
                            filterText: m.name,
                            detail: m.signature,
                            documentation: ("desc" in m && m.desc) ? {value: m.desc} : undefined,
                            range,
                            sortText: "0" + m.name,
                        };
                    }),
                };
            }

            // 3. 类名补全（大写开头）—— 合并硬编码 + 动态
            const word = model.getWordUntilPosition(position);
            const range = new monaco.Range(
                position.lineNumber, word.startColumn,
                position.lineNumber, word.endColumn,
            );
            if (word.word && word.word[0] === word.word[0].toUpperCase()) {
                const seen = new Set<string>();
                const all: (DictClass | JarDictClass)[] = [];
                for (const c of DICT) {
                    if (!seen.has(c.name)) { seen.add(c.name); all.push(c); }
                }
                for (const c of dynamicState.classes) {
                    if (!seen.has(c.name)) { seen.add(c.name); all.push(c); }
                }
                return {
                    suggestions: all.map(c => ({
                        label: {label: c.name, description: c.package},
                        kind: kindToMonaco(c.kind),
                        insertText: c.name,
                        filterText: c.name,
                        detail: `${c.package}.${c.name}`,
                        documentation: ("desc" in c && c.desc) ? {value: c.desc} : undefined,
                        range,
                        sortText: "1" + c.name,
                    })),
                };
            }

            return {suggestions: []};
        },
    });
}

// 跨打开文件按符号查找定义位置
export function findDefinition(name: string, preferPath?: string):
    { path: string; line: number; column: number } | null {
    const store = useIDEStore();
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns: RegExp[] = [
        new RegExp(`\\b(?:class|interface|enum|@interface)\\s+(${escaped})\\b`),
        new RegExp(`\\b(?:public|private|protected|static|final|abstract|synchronized|\\s)+\\s*\\w+(?:<[^>]+>)?(?:\\[\\])*\\s+(${escaped})\\s*\\(`),
        new RegExp(`\\b(?:public|private|protected|static|final|\\s)+\\s*\\w+(?:<[^>]+>)?(?:\\[\\])*\\s+(${escaped})\\s*[=;]`),
    ];

    const files = [...store.state.files].sort((a, b) => {
        if (a.path === preferPath) return -1;
        if (b.path === preferPath) return 1;
        return 0;
    });

    for (const f of files) {
        if (!f.path.endsWith(".java")) continue;
        for (const re of patterns) {
            const m = re.exec(f.content);
            if (m) {
                const nameIdx = m.index + m[0].lastIndexOf(name);
                const before = f.content.substring(0, nameIdx);
                const line = before.split("\n").length;
                const lineStart = before.lastIndexOf("\n") + 1;
                const column = nameIdx - lineStart + 1;
                return {path: f.path, line, column};
            }
        }
    }
    return null;
}
