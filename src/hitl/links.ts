// Where approval links point. stdio mode: the local page on 127.0.0.1 (set once it is
// listening). HTTP mode: the public URL of the deployed server.
let baseUrl = "http://127.0.0.1";

export function setApprovalBaseUrl(url: string) {
  baseUrl = url.replace(/\/+$/, "");
}

export function approvalUrl(id: string, token: string): string {
  return `${baseUrl}/approve/${id}?token=${token}`;
}
