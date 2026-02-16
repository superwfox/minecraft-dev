import {askDeepSeek} from "./DeepseekRequester";

export async function getType(prompt: string) {
    return await askDeepSeek(
        prompt,
        "请根据用户输入判断需求类型。 可选返回值 {\"\"} "
    );
}