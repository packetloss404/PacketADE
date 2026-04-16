use serde::{Deserialize, Serialize};

/// A chat message in the conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: MessageContent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
    System,
    Tool,
}

/// Message content — either plain text or structured content blocks.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

impl MessageContent {
    pub fn text(s: impl Into<String>) -> Self {
        Self::Text(s.into())
    }

    pub fn as_text(&self) -> &str {
        match self {
            Self::Text(s) => s,
            Self::Blocks(blocks) => {
                // Return first text block content, or empty
                for b in blocks {
                    if let ContentBlock::Text { text } = b {
                        return text;
                    }
                }
                ""
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        arguments: serde_json::Value,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_call_id: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
}

/// Tool definition sent to the LLM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    /// JSON Schema for the tool parameters.
    pub parameters: serde_json::Value,
}

/// A parsed tool call from the LLM response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// Result of executing a tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool_call_id: String,
    pub content: String,
    pub is_error: bool,
}

/// Streaming chunks emitted during an LLM response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum StreamChunk {
    /// A delta of text content.
    TextDelta { text: String },
    /// A tool use block has started.
    ToolUseStart { id: String, name: String },
    /// Partial JSON input for the current tool call.
    ToolUseInputDelta { delta: String },
    /// The current tool use block is complete with final parsed arguments.
    ToolUseEnd {
        id: String,
        name: String,
        arguments: serde_json::Value,
    },
    /// Stream is complete.
    Done {
        #[serde(default)]
        input_tokens: u64,
        #[serde(default)]
        output_tokens: u64,
    },
    /// An error occurred.
    Error { message: String },
}

/// Request to an LLM provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolDefinition>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default)]
    pub temperature: Option<f32>,
}

fn default_max_tokens() -> u32 {
    16384
}
