/**
 * Response from the child `request_input` tool.
 */
export interface InputResponse {
  /** Whether the parent responded. */
  responded: boolean;
  /** The response content, if the parent responded. */
  response?: string;
  /** Whether the request timed out. */
  timedOut: boolean;
}
