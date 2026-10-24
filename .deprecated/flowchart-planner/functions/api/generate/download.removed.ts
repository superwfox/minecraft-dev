        context.waitUntil(deleteTask(context.env, taskId, uid).catch(() => { }));
