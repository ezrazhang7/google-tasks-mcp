/** Minimal Google Tasks API v1 types — only the fields this server touches. */

export interface TaskList {
  kind?: "tasks#taskList";
  id: string;
  etag?: string;
  /** Max 1024 characters. */
  title: string;
  /** Output only, RFC 3339. */
  updated?: string;
  selfLink?: string;
}

export type TaskStatus = "needsAction" | "completed";

export interface TaskLink {
  type: string;
  description: string;
  link: string;
}

export interface AssignmentInfo {
  linkToTask?: string;
  surfaceType?: "CONTEXT_TYPE_UNSPECIFIED" | "GMAIL" | "DOCUMENT" | "SPACE";
  driveResourceInfo?: { driveFileId: string; resourceKey?: string };
  spaceInfo?: { space: string };
}

export interface Task {
  kind?: "tasks#task";
  id: string;
  etag?: string;
  /** Max 1024 characters. */
  title: string;
  /** Output only, RFC 3339. */
  updated?: string;
  selfLink?: string;
  /** Output only; omitted for top-level tasks. Change with `move`. */
  parent?: string;
  /** Output only; lexicographic sibling order. Change with `move`. */
  position?: string;
  /** Max 8192 characters. */
  notes?: string;
  status: TaskStatus;
  /**
   * RFC 3339 timestamp, but Google records the DATE ONLY — the time portion is
   * discarded on write and cannot be read or written via the API.
   */
  due?: string;
  /** RFC 3339; omitted unless status is "completed". */
  completed?: string;
  deleted?: boolean;
  /** Read-only: completed when the list was last cleared. */
  hidden?: boolean;
  links?: TaskLink[];
  /** Output only. */
  webViewLink?: string;
  /** Output only; present for tasks assigned from Docs/Chat/Gmail. */
  assignmentInfo?: AssignmentInfo;
}

export interface Page<T> {
  kind?: string;
  etag?: string;
  nextPageToken?: string;
  items?: T[];
}

/** Writable subset of Task for insert/patch. */
export interface TaskInput {
  title?: string;
  notes?: string | null;
  status?: TaskStatus;
  due?: string | null;
  completed?: string | null;
}

export interface ListTasksParams {
  showCompleted?: boolean;
  showHidden?: boolean;
  showDeleted?: boolean;
  showAssigned?: boolean;
  dueMin?: string;
  dueMax?: string;
  completedMin?: string;
  completedMax?: string;
  updatedMin?: string;
  /** Default 20, max 100. */
  maxResults?: number;
  pageToken?: string;
}
