import type { TokenProvider } from "./auth.js";
import type {
  ListTasksParams,
  Page,
  Task,
  TaskInput,
  TaskList,
} from "./types.js";

const TASKS_BASE = "https://tasks.googleapis.com/tasks/v1";

/** Google resolves this alias to the account's default list. */
export const DEFAULT_LIST = "@default";

/** Hard ceiling on tasks pulled by the auto-paginating helpers. */
const MAX_PAGINATED_TASKS = 2000;

/** An error returned by a Google API, carrying the HTTP status. */
export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

/**
 * A thin, runtime-agnostic client over the Tasks REST API.
 * One instance is bound per server connection / request.
 */
export class TasksClient {
  constructor(private readonly tokens: TokenProvider) {}

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {},
  ): Promise<T> {
    const url = new URL(`${TASKS_BASE}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const token = await this.tokens.getAccessToken();
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new GoogleApiError(res.status, extractApiMessage(text, res.status));
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  // ------------------------------------------------------------ Task lists

  listTaskLists(maxResults = 1000, pageToken?: string): Promise<Page<TaskList>> {
    return this.request<Page<TaskList>>("/users/@me/lists", {
      query: { maxResults, pageToken },
    });
  }

  async listAllTaskLists(): Promise<TaskList[]> {
    const out: TaskList[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.listTaskLists(1000, pageToken);
      out.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  getTaskList(listId: string): Promise<TaskList> {
    return this.request<TaskList>(`/users/@me/lists/${enc(listId)}`);
  }

  insertTaskList(title: string): Promise<TaskList> {
    return this.request<TaskList>("/users/@me/lists", {
      method: "POST",
      body: { title },
    });
  }

  patchTaskList(listId: string, title: string): Promise<TaskList> {
    return this.request<TaskList>(`/users/@me/lists/${enc(listId)}`, {
      method: "PATCH",
      body: { title },
    });
  }

  deleteTaskList(listId: string): Promise<void> {
    return this.request<void>(`/users/@me/lists/${enc(listId)}`, { method: "DELETE" });
  }

  /**
   * Resolve a user-facing list reference — an id, a title (case-insensitive),
   * or nothing for the default list — to a concrete list id.
   */
  async resolveList(ref: string | undefined): Promise<{ id: string; title: string }> {
    if (!ref || ref === DEFAULT_LIST) {
      const list = await this.getTaskList(DEFAULT_LIST);
      return { id: list.id, title: list.title };
    }
    const all = await this.listAllTaskLists();
    const byId = all.find((l) => l.id === ref);
    if (byId) return { id: byId.id, title: byId.title };
    const wanted = ref.trim().toLowerCase();
    const byTitle = all.filter((l) => l.title.trim().toLowerCase() === wanted);
    if (byTitle.length === 1) return { id: byTitle[0]!.id, title: byTitle[0]!.title };
    if (byTitle.length > 1) {
      throw new Error(
        `Several task lists are titled "${ref}"; use the id instead: ` +
          byTitle.map((l) => l.id).join(", "),
      );
    }
    const names = all.map((l) => `"${l.title}" (${l.id})`).join(", ");
    throw new Error(`No task list named or with id "${ref}". Available lists: ${names}`);
  }

  // ----------------------------------------------------------------- Tasks

  listTasks(listId: string, params: ListTasksParams = {}): Promise<Page<Task>> {
    return this.request<Page<Task>>(`/lists/${enc(listId)}/tasks`, {
      query: { ...params, maxResults: Math.min(params.maxResults ?? 100, 100) },
    });
  }

  /** Follow nextPageToken up to `limit` tasks (capped at MAX_PAGINATED_TASKS). */
  async listAllTasks(
    listId: string,
    params: Omit<ListTasksParams, "pageToken" | "maxResults">,
    limit = MAX_PAGINATED_TASKS,
  ): Promise<{ tasks: Task[]; truncated: boolean }> {
    const cap = Math.min(limit, MAX_PAGINATED_TASKS);
    const tasks: Task[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.listTasks(listId, {
        ...params,
        maxResults: Math.min(100, cap - tasks.length),
        pageToken,
      });
      tasks.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken && tasks.length < cap);
    return { tasks, truncated: Boolean(pageToken) };
  }

  getTask(listId: string, taskId: string): Promise<Task> {
    return this.request<Task>(`/lists/${enc(listId)}/tasks/${enc(taskId)}`);
  }

  insertTask(
    listId: string,
    body: TaskInput,
    position: { parent?: string; previous?: string } = {},
  ): Promise<Task> {
    return this.request<Task>(`/lists/${enc(listId)}/tasks`, {
      method: "POST",
      body,
      query: { parent: position.parent, previous: position.previous },
    });
  }

  patchTask(listId: string, taskId: string, body: TaskInput): Promise<Task> {
    return this.request<Task>(`/lists/${enc(listId)}/tasks/${enc(taskId)}`, {
      method: "PATCH",
      body,
    });
  }

  /** Full replace — used only to clear fields that PATCH won't null out. */
  updateTask(listId: string, taskId: string, body: Task): Promise<Task> {
    return this.request<Task>(`/lists/${enc(listId)}/tasks/${enc(taskId)}`, {
      method: "PUT",
      body,
    });
  }

  deleteTask(listId: string, taskId: string): Promise<void> {
    return this.request<void>(`/lists/${enc(listId)}/tasks/${enc(taskId)}`, {
      method: "DELETE",
    });
  }

  moveTask(
    listId: string,
    taskId: string,
    opts: { parent?: string; previous?: string; destinationTasklist?: string },
  ): Promise<Task> {
    return this.request<Task>(`/lists/${enc(listId)}/tasks/${enc(taskId)}/move`, {
      method: "POST",
      query: opts,
    });
  }

  clearCompleted(listId: string): Promise<void> {
    return this.request<void>(`/lists/${enc(listId)}/clear`, { method: "POST" });
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

/** Pull the human-readable message out of a Google error envelope. */
function extractApiMessage(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // not JSON
  }
  return text || `HTTP ${status}`;
}
