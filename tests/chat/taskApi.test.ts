import { afterEach, describe, expect, it, vi } from "vitest";

const hasOwnedTaskMock = vi.hoisted(() => vi.fn());
const deleteTaskMock = vi.hoisted(() => vi.fn());

vi.mock("../../functions/_lib/taskStore", async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    hasOwnedTask: hasOwnedTaskMock,
    deleteTask: deleteTaskMock,
}));

import { onRequestDelete as deleteTaskEndpoint } from "../../functions/api/generate/task";
import { TaskStoreUnavailableError } from "../../functions/_lib/taskStore";

function context(taskId = "task-1", uid = "user-1"): any {
    return {
        request: new Request(`https://example.test/api/generate/task?taskId=${taskId}`, {
            method: "DELETE",
        }),
        data: { uid },
        env: { TASKS: {} as KVNamespace },
    };
}

afterEach(() => {
    vi.clearAllMocks();
});

describe("DELETE /api/generate/task", () => {
    it("deletes an owned task and returns 204", async () => {
        hasOwnedTaskMock.mockResolvedValue(true);
        deleteTaskMock.mockResolvedValue(undefined);

        const response = await deleteTaskEndpoint(context());

        expect(response.status).toBe(204);
        expect(hasOwnedTaskMock).toHaveBeenCalledWith(expect.anything(), "task-1", "user-1");
        expect(deleteTaskMock).toHaveBeenCalledWith(expect.anything(), "task-1", "user-1");
    });

    it("returns the same 404 for a missing or non-owned task", async () => {
        hasOwnedTaskMock.mockResolvedValue(false);

        const response = await deleteTaskEndpoint(context());

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ code: "TASK_NOT_FOUND" });
        expect(deleteTaskMock).not.toHaveBeenCalled();
    });

    it("does not report success when durable task deletion fails", async () => {
        hasOwnedTaskMock.mockResolvedValue(true);
        deleteTaskMock.mockRejectedValue(new TaskStoreUnavailableError("D1 task delete failed"));

        await expect(deleteTaskEndpoint(context())).rejects.toBeInstanceOf(TaskStoreUnavailableError);
    });

    it("requires an authenticated user", async () => {
        const response = await deleteTaskEndpoint(context("task-1", ""));

        expect(response.status).toBe(401);
        expect(hasOwnedTaskMock).not.toHaveBeenCalled();
        expect(deleteTaskMock).not.toHaveBeenCalled();
    });
});
