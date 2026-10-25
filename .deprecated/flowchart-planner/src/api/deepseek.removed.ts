
const TODO_PRESET =
    "将需求转换为json数组，若内容无关则直接输出plainText而非json。用于表示实现步骤每个元素包含以下键值对，对于不同的事件 需要写在不同的step当中： " +
    "\"step\" : int ," +
    "\"content\" : String #如果使用该键值 则无需判断后续元素 直接返回 ," +
    "\"function\" : String #没有请填null ," +
    "\"params\" : String[] #没有请填null ," +
    "\"event\" : String #没有请填null";

export function getTodoList(prompt: string) {
    return askDeepSeek(prompt, TODO_PRESET);
}

export function streamGetTodoList(prompt: string, onDelta: (chunk: string) => void) {
    return streamAsk(prompt, TODO_PRESET, onDelta);
}
