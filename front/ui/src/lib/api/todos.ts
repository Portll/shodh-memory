import { api } from "./client";
import type { ListTodosRequest, TodoListResponse } from "./types";

/**
 * POST /api/todos — src/handlers/router.rs:288, `todos::list_todos`.
 *
 * Not `GET`: the handler takes a `Json<ListTodosRequest>` body, and the
 * "TUI compatibility" alias `/api/todos/list` (router.rs:289) confirms this
 * is the same contract the TUI dashboard already uses, not a bespoke one for
 * this UI.
 */
export function listTodos(req: ListTodosRequest, signal?: AbortSignal): Promise<TodoListResponse> {
  return api.post<TodoListResponse>("/api/todos", req, signal);
}
