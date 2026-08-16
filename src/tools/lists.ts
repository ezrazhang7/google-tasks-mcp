import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { TasksClient } from "../google/client.js";
import { jsonResult, runTool, textResult } from "../utils/result.js";
import { listRefSchema } from "./shared.js";

export function registerListTools(server: McpServer, client: TasksClient): void {
  server.registerTool(
    "list_tasklists",
    {
      title: "List task lists",
      description:
        "List all Google Tasks lists in the authorized account with their ids and titles. Call this first to learn which list to target.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () =>
      runTool(async () => {
        const lists = await client.listAllTaskLists();
        return jsonResult(
          lists.map((l) => ({ id: l.id, title: l.title, updated: l.updated })),
        );
      }),
  );

  server.registerTool(
    "create_tasklist",
    {
      title: "Create task list",
      description: "Create a new, empty task list.",
      inputSchema: z.object({
        title: z.string().min(1).max(1024).describe("List title"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ title }) =>
      runTool(async () => {
        const list = await client.insertTaskList(title);
        return jsonResult({ id: list.id, title: list.title });
      }),
  );

  server.registerTool(
    "rename_tasklist",
    {
      title: "Rename task list",
      description: "Rename an existing task list.",
      inputSchema: z.object({
        list: listRefSchema,
        title: z.string().min(1).max(1024).describe("New list title"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ list, title }) =>
      runTool(async () => {
        const { id } = await client.resolveList(list);
        const updated = await client.patchTaskList(id, title);
        return jsonResult({ id: updated.id, title: updated.title });
      }),
  );

  server.registerTool(
    "delete_tasklist",
    {
      title: "Delete task list",
      description:
        "Permanently delete a task list AND every task in it. Irreversible. Requires confirm=true.",
      inputSchema: z.object({
        list: z.string().describe("Task list id or exact title"),
        confirm: z
          .literal(true)
          .describe("Must be true — acknowledges that all tasks in the list will be deleted"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ list }) =>
      runTool(async () => {
        const { id, title } = await client.resolveList(list);
        await client.deleteTaskList(id);
        return textResult(`Deleted task list "${title}" (${id}).`);
      }),
  );
}
