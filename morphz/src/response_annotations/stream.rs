//! Original text is never JSON-decoded or reserialized. Retain only a possible
//! reserved trailer delimiter prefix; the body streams immediately. Both native
//! metadata and the separate implicit-reply trailer stay out of public output.
//! Validate metadata on the final Response independently of its body.
use super::{Protocol, ProtocolError, REPLY_TRAILER};
use crate::llm::ModelStreamEvent;
use std::collections::HashSet;

pub struct ModelStreamNormalizer {
    enabled: bool,
    metadata: HashSet<usize>,
    pending: String,
    in_trailer: bool,
}
impl ModelStreamNormalizer {
    pub fn new(protocol: Protocol) -> Self {
        Self {
            enabled: !protocol.is_off(),
            metadata: HashSet::new(),
            pending: String::new(),
            in_trailer: false,
        }
    }
    pub fn push(
        &mut self,
        event: ModelStreamEvent,
    ) -> Result<Vec<ModelStreamEvent>, ProtocolError> {
        if !self.enabled {
            return Ok(vec![event]);
        }
        if let ModelStreamEvent::TextDelta { text } = &event {
            if self.in_trailer {
                return Ok(vec![]);
            }
            self.pending.push_str(text);
            let body = if let Some(index) = self.pending.find(REPLY_TRAILER) {
                self.in_trailer = true;
                self.pending[..index].to_owned()
            } else {
                // Retain at most one ASCII delimiter prefix, not the body or
                // its JSON/Markdown structure. Provider chunks may split it.
                let keep = (1..REPLY_TRAILER.len())
                    .rev()
                    .find(|n| self.pending.ends_with(&REPLY_TRAILER[..*n]))
                    .unwrap_or(0);
                let split = self.pending.len() - keep;
                let body = self.pending[..split].to_owned();
                self.pending = self.pending[split..].to_owned();
                return Ok(if body.is_empty() {
                    vec![]
                } else {
                    vec![ModelStreamEvent::TextDelta { text: body }]
                });
            };
            self.pending.clear();
            return Ok(if body.is_empty() {
                vec![]
            } else {
                vec![ModelStreamEvent::TextDelta { text: body }]
            });
        }
        if matches!(
            event,
            ModelStreamEvent::Completed | ModelStreamEvent::Incomplete { .. }
        ) && !self.pending.is_empty()
            && !self.in_trailer
        {
            return Ok(vec![
                ModelStreamEvent::TextDelta {
                    text: std::mem::take(&mut self.pending),
                },
                event,
            ]);
        }
        let private = match &event {
            ModelStreamEvent::ToolCallStarted { index, name, .. } if name == "reply" => {
                self.metadata.insert(*index);
                true
            }
            ModelStreamEvent::ToolArgumentsDelta { index, .. }
            | ModelStreamEvent::ToolCallCompleted { index } => self.metadata.contains(index),
            _ => false,
        };
        Ok(if private { vec![] } else { vec![event] })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordinary_text_is_immediate_and_byte_identical_with_or_without_annotations() {
        for protocol in [Protocol::On, Protocol::Off] {
            let mut stream = ModelStreamNormalizer::new(protocol);
            let body = "{\"business\":\"value\"}\n\n中文🧠\t引号\"与反斜线\\都不是控制语法。";
            let mut output = String::new();
            for c in body.chars() {
                let delta = c.to_string();
                let events = stream
                    .push(ModelStreamEvent::TextDelta {
                        text: delta.clone(),
                    })
                    .unwrap();
                for event in events {
                    if let ModelStreamEvent::TextDelta { text } = event {
                        output.push_str(&text);
                    } else {
                        panic!("body changed type");
                    }
                }
                assert!(stream.pending.len() < REPLY_TRAILER.len());
            }
            for event in stream.push(ModelStreamEvent::Completed).unwrap() {
                if let ModelStreamEvent::TextDelta { text } = event {
                    output.push_str(&text);
                }
            }
            assert_eq!(output, body);
        }
    }
    #[test]
    fn implicit_reply_trailer_is_private_across_every_chunk_boundary() {
        let body = "{\"business\":false}\n中文\"\\\t原样";
        let content=format!("{body}{REPLY_TRAILER}{{\"annotations\":{{\"execution\":{{\"title\":\"标题\",\"result\":\"结果\"}}}}}}\n:::");
        let chars: Vec<_> = content.chars().collect();
        for size in 1..=chars.len() {
            let mut stream = ModelStreamNormalizer::new(Protocol::On);
            let mut output = String::new();
            for chunk in chars.chunks(size) {
                for event in stream
                    .push(ModelStreamEvent::TextDelta {
                        text: chunk.iter().collect(),
                    })
                    .unwrap()
                {
                    if let ModelStreamEvent::TextDelta { text } = event {
                        output.push_str(&text);
                    }
                }
            }
            assert_eq!(output, body, "chunk size {size}");
            assert!(stream
                .push(ModelStreamEvent::Completed)
                .unwrap()
                .iter()
                .all(|event| !matches!(event, ModelStreamEvent::TextDelta { .. })));
        }
    }
    #[test]
    fn metadata_never_becomes_body_and_malformed_metadata_never_cuts_off_text() {
        let mut stream = ModelStreamNormalizer::new(Protocol::On);
        assert!(stream
            .push(ModelStreamEvent::ToolCallStarted {
                index: 0,
                id: "metadata".into(),
                name: "reply".into()
            })
            .unwrap()
            .is_empty());
        assert!(stream
            .push(ModelStreamEvent::ToolArgumentsDelta {
                index: 0,
                delta: "{broken\nmetadata".into()
            })
            .unwrap()
            .is_empty());
        assert_eq!(
            stream
                .push(ModelStreamEvent::TextDelta {
                    text: "正文继续显示。".into()
                })
                .unwrap()
                .len(),
            1
        );
        assert!(stream
            .push(ModelStreamEvent::ToolCallCompleted { index: 0 })
            .unwrap()
            .is_empty());
        assert_eq!(stream.push(ModelStreamEvent::Completed).unwrap().len(), 1);
    }
    #[test]
    fn work_and_disabled_metadata_events_are_not_rewritten() {
        for (protocol, name) in [(Protocol::On, "read"), (Protocol::Off, "reply")] {
            let mut stream = ModelStreamNormalizer::new(protocol);
            for event in [
                ModelStreamEvent::ToolCallStarted {
                    index: 1,
                    id: "call".into(),
                    name: name.into(),
                },
                ModelStreamEvent::ToolArgumentsDelta {
                    index: 1,
                    delta: "{\"value\":1}".into(),
                },
                ModelStreamEvent::ToolCallCompleted { index: 1 },
            ] {
                let expected = format!("{event:?}");
                let actual = stream.push(event).unwrap();
                assert_eq!(actual.len(), 1);
                assert_eq!(format!("{:?}", actual[0]), expected);
            }
        }
    }
}
