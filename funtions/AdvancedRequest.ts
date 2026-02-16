import {askDeepSeek} from "./DeepseekRequester";

export async function getInfo(prompt: string) {
    return await askDeepSeek(
        prompt,
        "请根据用户输入判断需求返回json，若内容无关则plainText。 键值对如下： " +
        "\"coreType\" : {\"PAPER\",\"BUKKIT\",\"SPIGOT\",\"FORGE\",\"FABRIC\",\"其他\",\"null\"} ," +
        "\"version\" : {\"1.8\",\"1.9\",\"1.10\",\"1.11\",\"1.12\",\"1.13\",\"1.14\",\"1.15\",\"1.16\",\"1.17\",\"1.18\",\"1.19\",\"1.20\",\"1.21\",\"null\"} ," +
        "\"title\" : String ," +
        "\"rawPrompt\" : String "
    );
}

export async function getTodoList(prompt: string) {
    return await askDeepSeek(
        prompt,
        "将需求转换为json数组，若内容无关则plainText，用于表示实现步骤每个元素包含以下键值对： " +
        "\"step\" : int ," +
        "\"content\" : String #如果使用该键值 则无需判断后续元素 直接返回 ," +
        "\"function\" : String #没有请填null ," +
        "\"params\" : String[] #没有请填null ," +
        "\"event\" : String #没有请填null"
    );
}