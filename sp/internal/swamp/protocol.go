package swamp

import (
	"encoding/json"
)

// Request type literals of the swamp serve protocol. The protocol uses a single
// `type` discriminator on both directions; there is no method field.
const (
	ReqServerVersion     = "server.version"
	ReqModelSearch       = "model.search"
	ReqModelGet          = "model.get"
	ReqModelTypeSearch   = "model.type.search"
	ReqModelTypeDescribe = "model.type.describe"
	ReqWorkflowSearch    = "workflow.search"
	ReqWorkflowGet       = "workflow.get"
	ReqWorkflowRun       = "workflow.run"
	ReqWorkflowResume    = "workflow.resume"
	ReqWorkflowCancel    = "workflow.cancel"
	ReqWorkflowRunSearch = "workflow.run.search"
	ReqMethodRun         = "model.method.run"
	ReqDataList          = "data.list"
	ReqDataQuery         = "data.query"
	ReqDataGet           = "data.get"
	ReqDataVersions      = "data.versions"
	ReqRunHistory        = "run.history"
	ReqRunAttach         = "run.attach"
	ReqCancel            = "cancel"
)

// wireRequest is the client -> server envelope.
type wireRequest struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Payload any    `json:"payload,omitempty"`
}

// wireFrame is any server -> client frame. The Type field selects which of the
// other fields is populated:
//
//	Type == <request type>  -> Payload holds the response payload
//	Type == "event"         -> Event holds a SerializedEvent
//	Type == "error"         -> Error holds a SerializedError
//	Type == "done"          -> terminal frame for a streaming request
type wireFrame struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Event   json.RawMessage `json:"event,omitempty"`
	Error   *WireError      `json:"error,omitempty"`
}

// WireError is the server's SerializedError.
type WireError struct {
	Code    string          `json:"code"`
	Message string          `json:"message"`
	Details json.RawMessage `json:"details,omitempty"`
}

func (e *WireError) Error() string {
	if e == nil {
		return "unknown error"
	}
	return e.Code + ": " + e.Message
}

// AuthInfo is the unauthenticated GET /auth/info response.
type AuthInfo struct {
	Mode                string `json:"mode"`
	VerificationBaseURI string `json:"verificationBaseUri,omitempty"`
}

// dataEnvelope is the common shape of data-bearing payloads: the result is
// wrapped under a "data" key (except run.history, which returns "runs").
type dataEnvelope struct {
	Data json.RawMessage `json:"data"`
}

// RunHistoryEntry mirrors the run.history response element.
type RunHistoryEntry struct {
	ID           string `json:"id"`
	RunKind      string `json:"runKind"`
	ModelType    string `json:"modelType"`
	MethodName   string `json:"methodName"`
	WorkflowName string `json:"workflowName"`
	Status       string `json:"status"`
	StartedAt    string `json:"startedAt"`
	Stale        bool   `json:"stale"`
}

// RunHistoryResponse is the run.history payload (not wrapped in "data").
type RunHistoryResponse struct {
	Runs []RunHistoryEntry `json:"runs"`
}
