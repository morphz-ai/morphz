use super::Theme;
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

pub(super) fn render(markdown: &str, theme: Theme, width: u16) -> Vec<Line<'static>> {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_SMART_PUNCTUATION);
    options.insert(Options::ENABLE_GFM);

    let mut renderer = Renderer::new(theme, width);
    for event in Parser::new_ext(markdown, options) {
        renderer.event(event);
    }
    renderer.finish()
}

#[derive(Debug)]
struct ListState {
    next: Option<u64>,
}

struct Renderer {
    theme: Theme,
    width: u16,
    lines: Vec<Line<'static>>,
    current: Vec<Span<'static>>,
    line_prefixed: bool,
    lists: Vec<ListState>,
    item_first_lines: Vec<bool>,
    quote_depth: usize,
    heading_depth: usize,
    emphasis_depth: usize,
    strong_depth: usize,
    strike_depth: usize,
    code_block: bool,
    link_destinations: Vec<String>,
    image_destinations: Vec<String>,
}

impl Renderer {
    fn new(theme: Theme, width: u16) -> Self {
        Self {
            theme,
            width,
            lines: Vec::new(),
            current: Vec::new(),
            line_prefixed: false,
            lists: Vec::new(),
            item_first_lines: Vec::new(),
            quote_depth: 0,
            heading_depth: 0,
            emphasis_depth: 0,
            strong_depth: 0,
            strike_depth: 0,
            code_block: false,
            link_destinations: Vec::new(),
            image_destinations: Vec::new(),
        }
    }

    fn event(&mut self, event: Event<'_>) {
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(text) => self.push_text(&text, self.text_style()),
            Event::Code(code) => {
                self.push_text(&code, Style::default().fg(self.theme.text_secondary))
            }
            Event::InlineMath(math) => self.push_text(
                &format!("${math}$"),
                Style::default().fg(self.theme.text_secondary),
            ),
            Event::DisplayMath(math) => {
                self.finish_line(false);
                self.push_text(
                    &format!("$${math}$$"),
                    Style::default().fg(self.theme.text_secondary),
                );
                self.finish_line(false);
                self.blank_line();
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                self.push_text(&html, Style::default().fg(self.theme.text_muted));
            }
            Event::FootnoteReference(label) => self.push_text(
                &format!("[^{label}]"),
                Style::default()
                    .fg(self.theme.text_secondary)
                    .add_modifier(Modifier::UNDERLINED),
            ),
            // In a chat transcript, the model's line breaks carry presentation
            // intent (poetry is the most obvious example). CommonMark treats a
            // single newline as a soft break and normally folds it into a space,
            // but doing that here destroys the original response layout.
            Event::SoftBreak => self.finish_line(true),
            Event::HardBreak => self.finish_line(true),
            Event::Rule => {
                self.finish_line(false);
                self.push_text(
                    &"─".repeat(usize::from(self.width.clamp(1, 48))),
                    Style::default().fg(self.theme.border_subtle),
                );
                self.finish_line(false);
                self.blank_line();
            }
            Event::TaskListMarker(checked) => self.push_text(
                if checked { "[✓] " } else { "[ ] " },
                Style::default().fg(if checked {
                    self.theme.success
                } else {
                    self.theme.text_muted
                }),
            ),
        }
    }

    fn start(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph => {
                if !self.current.is_empty() {
                    self.finish_line(false);
                }
            }
            Tag::Heading { .. } => {
                self.finish_line(false);
                self.heading_depth += 1;
            }
            Tag::BlockQuote(_) => {
                self.finish_line(false);
                self.quote_depth += 1;
            }
            Tag::CodeBlock(kind) => {
                self.finish_line(false);
                self.code_block = true;
                if let CodeBlockKind::Fenced(language) = kind {
                    if !language.trim().is_empty() {
                        self.push_text(
                            language.trim(),
                            Style::default()
                                .fg(self.theme.text_muted)
                                .add_modifier(Modifier::ITALIC),
                        );
                        self.finish_line(false);
                    }
                }
            }
            Tag::List(first) => {
                self.finish_line(false);
                self.lists.push(ListState { next: first });
            }
            Tag::Item => self.start_item(),
            Tag::Emphasis => self.emphasis_depth += 1,
            Tag::Strong => self.strong_depth += 1,
            Tag::Strikethrough => self.strike_depth += 1,
            Tag::Link { dest_url, .. } => {
                self.link_destinations.push(dest_url.into_string());
            }
            Tag::Image { dest_url, .. } => {
                self.image_destinations.push(dest_url.into_string());
                self.push_text("image: ", Style::default().fg(self.theme.text_muted));
            }
            Tag::HtmlBlock
            | Tag::FootnoteDefinition(_)
            | Tag::DefinitionList
            | Tag::DefinitionListTitle
            | Tag::DefinitionListDefinition
            | Tag::Table(_)
            | Tag::TableHead
            | Tag::TableRow
            | Tag::TableCell
            | Tag::Superscript
            | Tag::Subscript
            | Tag::MetadataBlock(_) => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph => {
                self.finish_line(false);
                if self.lists.is_empty() {
                    self.blank_line();
                }
            }
            TagEnd::Heading(_) => {
                self.heading_depth = self.heading_depth.saturating_sub(1);
                self.finish_line(false);
                self.blank_line();
            }
            TagEnd::BlockQuote(_) => {
                self.finish_line(false);
                self.quote_depth = self.quote_depth.saturating_sub(1);
                self.blank_line();
            }
            TagEnd::CodeBlock => {
                self.finish_line(false);
                self.code_block = false;
                self.blank_line();
            }
            TagEnd::List(_) => {
                self.finish_line(false);
                self.lists.pop();
                if self.lists.is_empty() {
                    self.blank_line();
                }
            }
            TagEnd::Item => {
                self.finish_line(false);
                self.item_first_lines.pop();
            }
            TagEnd::Emphasis => self.emphasis_depth = self.emphasis_depth.saturating_sub(1),
            TagEnd::Strong => self.strong_depth = self.strong_depth.saturating_sub(1),
            TagEnd::Strikethrough => self.strike_depth = self.strike_depth.saturating_sub(1),
            TagEnd::Link => {
                if let Some(destination) = self.link_destinations.pop() {
                    if !destination.is_empty() {
                        self.push_text(
                            &format!(" ({destination})"),
                            Style::default().fg(self.theme.text_muted),
                        );
                    }
                }
            }
            TagEnd::Image => {
                if let Some(destination) = self.image_destinations.pop() {
                    if !destination.is_empty() {
                        self.push_text(
                            &format!(" ({destination})"),
                            Style::default().fg(self.theme.text_muted),
                        );
                    }
                }
            }
            TagEnd::HtmlBlock
            | TagEnd::FootnoteDefinition
            | TagEnd::DefinitionList
            | TagEnd::DefinitionListTitle
            | TagEnd::DefinitionListDefinition
            | TagEnd::Table
            | TagEnd::TableHead
            | TagEnd::TableRow
            | TagEnd::TableCell
            | TagEnd::Superscript
            | TagEnd::Subscript
            | TagEnd::MetadataBlock(_) => {}
        }
    }

    fn start_item(&mut self) {
        self.finish_line(false);
        self.item_first_lines.push(true);
        self.ensure_quote_prefix();
        if self.lists.len() > 1 {
            self.current
                .push(Span::raw("  ".repeat(self.lists.len() - 1)));
        }
        let marker = self
            .lists
            .last_mut()
            .map(|list| match list.next {
                Some(number) => {
                    list.next = Some(number.saturating_add(1));
                    format!("{number}. ")
                }
                None => "• ".to_string(),
            })
            .unwrap_or_else(|| "• ".to_string());
        self.current.push(Span::styled(
            marker,
            Style::default().fg(self.theme.text_muted),
        ));
        self.line_prefixed = true;
    }

    fn push_text(&mut self, text: &str, style: Style) {
        let mut fragments = text.split('\n').peekable();
        while let Some(fragment) = fragments.next() {
            if !fragment.is_empty() {
                self.ensure_line_prefix();
                self.current.push(Span::styled(fragment.to_string(), style));
            }
            if fragments.peek().is_some() {
                self.finish_line(true);
            }
        }
    }

    fn ensure_line_prefix(&mut self) {
        if self.line_prefixed {
            return;
        }
        self.ensure_quote_prefix();
        if self.code_block {
            self.current.push(Span::styled(
                "│ ",
                Style::default().fg(self.theme.border_subtle),
            ));
        } else if self.item_first_lines.last() == Some(&false) {
            self.current.push(Span::raw("  ".repeat(self.lists.len())));
        }
        self.line_prefixed = true;
    }

    fn ensure_quote_prefix(&mut self) {
        for _ in 0..self.quote_depth {
            self.current.push(Span::styled(
                "│ ",
                Style::default().fg(self.theme.border_subtle),
            ));
        }
    }

    fn text_style(&self) -> Style {
        let color = if self.code_block || self.quote_depth > 0 {
            self.theme.text_secondary
        } else {
            self.theme.text_primary
        };
        let mut modifiers = Modifier::empty();
        if self.heading_depth > 0 || self.strong_depth > 0 {
            modifiers |= Modifier::BOLD;
        }
        if self.emphasis_depth > 0 || self.quote_depth > 0 {
            modifiers |= Modifier::ITALIC;
        }
        if self.strike_depth > 0 {
            modifiers |= Modifier::CROSSED_OUT;
        }
        if !self.link_destinations.is_empty() {
            modifiers |= Modifier::UNDERLINED;
        }
        Style::default().fg(color).add_modifier(modifiers)
    }

    fn finish_line(&mut self, force: bool) {
        if force || !self.current.is_empty() {
            self.lines
                .push(Line::from(std::mem::take(&mut self.current)));
            if let Some(first_line) = self.item_first_lines.last_mut() {
                *first_line = false;
            }
        }
        self.line_prefixed = false;
    }

    fn blank_line(&mut self) {
        self.finish_line(false);
        let already_blank = self
            .lines
            .last()
            .is_some_and(|line| line.spans.iter().all(|span| span.content.is_empty()));
        if !already_blank {
            self.lines.push(Line::from(""));
        }
    }

    fn finish(mut self) -> Vec<Line<'static>> {
        self.finish_line(false);
        while self
            .lines
            .last()
            .is_some_and(|line| line.spans.iter().all(|span| span.content.is_empty()))
        {
            self.lines.pop();
        }
        if self.lines.is_empty() {
            self.lines.push(Line::from(""));
        }
        self.lines
    }
}

#[cfg(test)]
mod tests {
    use super::super::TerminalAppearance;
    use super::*;
    use crate::config::TuiTheme;

    fn text(lines: &[Line<'_>]) -> String {
        lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn renders_common_markdown_without_leaking_delimiters() {
        let theme = Theme::for_appearance(TuiTheme::Cyan, TerminalAppearance::Dark);
        let lines = render(
            "# Heading\n\n**bold** and *emphasis* with `code`.\n\n- [x] done\n- next\n\n> quote\n\n[docs](https://example.com)",
            theme,
            80,
        );
        let output = text(&lines);

        assert!(output.contains("Heading"));
        assert!(output.contains("bold and emphasis with code."));
        assert!(output.contains("• [✓] done"));
        assert!(output.contains("│ quote"));
        assert!(output.contains("docs (https://example.com)"));
        for delimiter in ["**", "`code`", "]("] {
            assert!(!output.contains(delimiter));
        }
        let bold = lines
            .iter()
            .flat_map(|line| &line.spans)
            .find(|span| span.content == "bold")
            .expect("bold span");
        assert!(bold.style.add_modifier.contains(Modifier::BOLD));
        let emphasis = lines
            .iter()
            .flat_map(|line| &line.spans)
            .find(|span| span.content == "emphasis")
            .expect("emphasis span");
        assert!(emphasis.style.add_modifier.contains(Modifier::ITALIC));
    }

    #[test]
    fn preserves_source_line_breaks_inside_markdown_paragraphs() {
        let theme = Theme::for_appearance(TuiTheme::Cyan, TerminalAppearance::Dark);
        let lines = render(
            "《慢下来的下午》\n一句 hello 走了三十秒，\n窗外无事发生，\n风把云推到一边。",
            theme,
            80,
        );

        assert_eq!(
            text(&lines),
            "《慢下来的下午》\n一句 hello 走了三十秒，\n窗外无事发生，\n风把云推到一边。"
        );
    }

    #[test]
    fn preserves_soft_breaks_with_inline_styles_and_list_indentation() {
        let theme = Theme::for_appearance(TuiTheme::Cyan, TerminalAppearance::Dark);
        let lines = render(
            "**first line**\nsecond line\n\n- item line one\n  item line two",
            theme,
            80,
        );
        let output = text(&lines);

        assert!(output.contains("first line\nsecond line"));
        assert!(output.contains("• item line one\n  item line two"));
        let first_line = lines
            .iter()
            .flat_map(|line| &line.spans)
            .find(|span| span.content == "first line")
            .expect("styled first line");
        assert!(first_line.style.add_modifier.contains(Modifier::BOLD));
    }
}
