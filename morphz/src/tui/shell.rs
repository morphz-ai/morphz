use super::{centered_rect, Theme, TuiError};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseEventKind};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear, Paragraph};
use ratatui::Frame;
use std::fmt;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, TryRecvError};

const INITIAL_ROWS: u16 = 24;
const INITIAL_COLS: u16 = 80;
const SCROLLBACK_ROWS: usize = 10_000;

enum ShellOutput {
    Data(Vec<u8>),
    Eof,
    Error(String),
}
/// A persistent shell attached to a real pseudo-terminal.
///
/// The PTY keeps shell state such as cwd, exported variables and command history
/// alive while the overlay is hidden. Output is parsed into a terminal screen so
/// full-screen programs can run without writing escape sequences into Morphz.
pub(super) struct EmbeddedShell {
    parser: vt100::Parser,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    output_rx: Receiver<ShellOutput>,
    shell_name: String,
    size: (u16, u16),
    exit_status: Option<String>,
    io_error: Option<String>,
}

impl fmt::Debug for EmbeddedShell {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EmbeddedShell")
            .field("shell_name", &self.shell_name)
            .field("size", &self.size)
            .field("exit_status", &self.exit_status)
            .field("io_error", &self.io_error)
            .finish_non_exhaustive()
    }
}

impl EmbeddedShell {
    pub(super) fn spawn(cwd: &Path) -> Result<Self, TuiError> {
        let shell_path = std::env::var_os("SHELL")
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| PathBuf::from("/bin/sh"));
        let shell_name = shell_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("shell")
            .to_string();

        let pty_system = native_pty_system();
        let pair = pty_system.openpty(pty_size(INITIAL_ROWS, INITIAL_COLS))?;
        let mut command = CommandBuilder::new(&shell_path);
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "Morphz");
        command.env("MORPHZ_EMBEDDED_SHELL", "1");

        let child = pair.slave.spawn_command(command)?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let (output_tx, output_rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("morphz-pty-reader".to_string())
            .spawn(move || {
                let mut buffer = vec![0_u8; 16 * 1024];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => {
                            let _ = output_tx.send(ShellOutput::Eof);
                            break;
                        }
                        Ok(read) => {
                            if output_tx
                                .send(ShellOutput::Data(buffer[..read].to_vec()))
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(error) => {
                            let _ = output_tx.send(ShellOutput::Error(error.to_string()));
                            break;
                        }
                    }
                }
            })?;

        Ok(Self {
            parser: vt100::Parser::new(INITIAL_ROWS, INITIAL_COLS, SCROLLBACK_ROWS),
            master: pair.master,
            writer,
            child,
            output_rx,
            shell_name,
            size: (INITIAL_ROWS, INITIAL_COLS),
            exit_status: None,
            io_error: None,
        })
    }

    pub(super) fn is_finished(&mut self) -> bool {
        self.poll();
        self.exit_status.is_some()
    }

    pub(super) fn poll(&mut self) {
        loop {
            match self.output_rx.try_recv() {
                Ok(ShellOutput::Data(bytes)) => self.parser.process(&bytes),
                Ok(ShellOutput::Eof) => break,
                Ok(ShellOutput::Error(error)) => {
                    self.io_error = Some(error);
                    break;
                }
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
            }
        }
        if self.exit_status.is_none() {
            match self.child.try_wait() {
                Ok(Some(status)) => self.exit_status = Some(status.to_string()),
                Ok(None) => {}
                Err(error) => self.io_error = Some(error.to_string()),
            }
        }
    }

    pub(super) fn send_key(&mut self, key: KeyEvent) {
        if self.exit_status.is_some() {
            return;
        }
        self.parser.screen_mut().set_scrollback(0);
        let bytes = key_bytes(key, self.parser.screen().application_cursor());
        self.write_input(&bytes);
    }

    pub(super) fn send_paste(&mut self, text: &str) {
        if self.exit_status.is_some() {
            return;
        }
        self.parser.screen_mut().set_scrollback(0);
        if self.parser.screen().bracketed_paste() {
            self.write_input(b"\x1b[200~");
            self.write_input(text.as_bytes());
            self.write_input(b"\x1b[201~");
        } else {
            self.write_input(text.as_bytes());
        }
    }

    pub(super) fn handle_mouse(&mut self, kind: MouseEventKind) {
        let page = usize::from(self.size.0.saturating_sub(2).max(1));
        let current = self.parser.screen().scrollback();
        match kind {
            MouseEventKind::ScrollUp => self
                .parser
                .screen_mut()
                .set_scrollback(current.saturating_add(page / 3).max(1)),
            MouseEventKind::ScrollDown => self
                .parser
                .screen_mut()
                .set_scrollback(current.saturating_sub((page / 3).max(1))),
            _ => {}
        }
    }

    pub(super) fn render(&mut self, frame: &mut Frame<'_>, theme: Theme) {
        self.poll();
        let area = centered_rect(90, 82, frame.area());
        frame.render_widget(Clear, area);

        let title = format!(" Shell · {} ", self.shell_name);
        let block = Block::default()
            .title(Line::from(Span::styled(
                title,
                Style::default()
                    .fg(theme.brand)
                    .add_modifier(Modifier::BOLD),
            )))
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(theme.border_strong));
        let inner = block.inner(area);
        frame.render_widget(block, area);

        if inner.width == 0 || inner.height < 2 {
            return;
        }
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(1), Constraint::Length(1)])
            .split(inner);
        let terminal_area = rows[0];
        self.resize(terminal_area.height.max(1), terminal_area.width.max(1));
        self.render_screen(frame, terminal_area, theme);

        let status = if let Some(exit_status) = &self.exit_status {
            format!("Shell {exit_status} · closing…")
        } else if let Some(error) = &self.io_error {
            format!("Shell I/O error: {error}")
        } else if self.parser.screen().scrollback() > 0 {
            format!(
                "history {} lines · wheel scroll · Ctrl+P hide",
                self.parser.screen().scrollback()
            )
        } else {
            "Ctrl+P hide · exit close · mouse wheel history".to_string()
        };
        frame.render_widget(
            Paragraph::new(status)
                .style(Style::default().fg(theme.text_muted))
                .alignment(Alignment::Right),
            rows[1],
        );
    }

    fn resize(&mut self, rows: u16, cols: u16) {
        if self.size == (rows, cols) {
            return;
        }
        self.parser.screen_mut().set_size(rows, cols);
        match self.master.resize(pty_size(rows, cols)) {
            Ok(()) => self.size = (rows, cols),
            Err(error) => self.io_error = Some(error.to_string()),
        }
    }

    fn render_screen(&self, frame: &mut Frame<'_>, area: Rect, theme: Theme) {
        let screen = self.parser.screen();
        let buffer = frame.buffer_mut();
        for row in 0..area.height {
            for col in 0..area.width {
                let Some(source) = screen.cell(row, col) else {
                    continue;
                };
                if source.is_wide_continuation() {
                    continue;
                }
                let symbol = if source.has_contents() {
                    source.contents()
                } else {
                    " "
                };
                let Some(target) = buffer.cell_mut((area.x + col, area.y + row)) else {
                    continue;
                };
                target
                    .set_symbol(symbol)
                    .set_style(cell_style(source, theme));
            }
        }
        if !screen.hide_cursor() && screen.scrollback() == 0 && self.exit_status.is_none() {
            let (row, col) = screen.cursor_position();
            frame.set_cursor_position((
                area.x + col.min(area.width.saturating_sub(1)),
                area.y + row.min(area.height.saturating_sub(1)),
            ));
        }
    }

    fn write_input(&mut self, bytes: &[u8]) {
        if bytes.is_empty() || self.io_error.is_some() {
            return;
        }
        if let Err(error) = self
            .writer
            .write_all(bytes)
            .and_then(|()| self.writer.flush())
        {
            self.io_error = Some(error.to_string());
        }
    }
}

impl Drop for EmbeddedShell {
    fn drop(&mut self) {
        if self.exit_status.is_none() {
            let _ = self.child.kill();
        }
    }
}

fn pty_size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn cell_style(cell: &vt100::Cell, theme: Theme) -> Style {
    let mut style = Style::default()
        .fg(vt_color(cell.fgcolor(), theme.text_primary))
        .bg(vt_color(cell.bgcolor(), Color::Reset));
    let mut modifiers = Modifier::empty();
    if cell.bold() {
        modifiers |= Modifier::BOLD;
    }
    if cell.dim() {
        modifiers |= Modifier::DIM;
    }
    if cell.italic() {
        modifiers |= Modifier::ITALIC;
    }
    if cell.underline() {
        modifiers |= Modifier::UNDERLINED;
    }
    if cell.inverse() {
        modifiers |= Modifier::REVERSED;
    }
    style = style.add_modifier(modifiers);
    style
}

fn vt_color(color: vt100::Color, default: Color) -> Color {
    match color {
        vt100::Color::Default => default,
        vt100::Color::Idx(index) => Color::Indexed(index),
        vt100::Color::Rgb(red, green, blue) => Color::Rgb(red, green, blue),
    }
}

fn key_bytes(key: KeyEvent, application_cursor: bool) -> Vec<u8> {
    let modifiers = key.modifiers;
    let alt = modifiers.contains(KeyModifiers::ALT);
    let control = modifiers.contains(KeyModifiers::CONTROL);
    let mut bytes = Vec::new();

    match key.code {
        KeyCode::Char(character) if control => {
            if alt {
                bytes.push(0x1b);
            }
            if let Some(byte) = control_byte(character) {
                bytes.push(byte);
            } else {
                bytes.extend(character.to_string().as_bytes());
            }
        }
        KeyCode::Char(character) => {
            if alt {
                bytes.push(0x1b);
            }
            bytes.extend(character.to_string().as_bytes());
        }
        KeyCode::Enter => push_simple_key(&mut bytes, alt, b'\r'),
        KeyCode::Backspace => push_simple_key(&mut bytes, alt, 0x7f),
        KeyCode::Tab => push_simple_key(&mut bytes, alt, b'\t'),
        KeyCode::BackTab => bytes.extend_from_slice(b"\x1b[Z"),
        KeyCode::Esc => push_simple_key(&mut bytes, alt, 0x1b),
        KeyCode::Null => push_simple_key(&mut bytes, alt, 0),
        KeyCode::Up => {
            bytes.extend_from_slice(cursor_sequence(b'A', modifiers, application_cursor))
        }
        KeyCode::Down => {
            bytes.extend_from_slice(cursor_sequence(b'B', modifiers, application_cursor))
        }
        KeyCode::Right => {
            bytes.extend_from_slice(cursor_sequence(b'C', modifiers, application_cursor))
        }
        KeyCode::Left => {
            bytes.extend_from_slice(cursor_sequence(b'D', modifiers, application_cursor))
        }
        KeyCode::Home => bytes.extend(csi_tilde_or_cursor(b'H', 1, modifiers)),
        KeyCode::End => bytes.extend(csi_tilde_or_cursor(b'F', 4, modifiers)),
        KeyCode::Insert => bytes.extend_from_slice(csi_tilde(2, modifiers).as_bytes()),
        KeyCode::Delete => bytes.extend_from_slice(csi_tilde(3, modifiers).as_bytes()),
        KeyCode::PageUp => bytes.extend_from_slice(csi_tilde(5, modifiers).as_bytes()),
        KeyCode::PageDown => bytes.extend_from_slice(csi_tilde(6, modifiers).as_bytes()),
        KeyCode::F(number) => bytes.extend_from_slice(function_key(number, modifiers).as_bytes()),
        KeyCode::KeypadBegin => bytes.extend_from_slice(b"\x1b[E"),
        _ => {}
    }
    bytes
}

fn push_simple_key(bytes: &mut Vec<u8>, alt: bool, byte: u8) {
    if alt {
        bytes.push(0x1b);
    }
    bytes.push(byte);
}

fn control_byte(character: char) -> Option<u8> {
    match character {
        ' ' | '@' | '`' => Some(0),
        'a'..='z' => Some((character as u8) - b'a' + 1),
        'A'..='Z' => Some((character as u8) - b'A' + 1),
        '[' | '{' => Some(27),
        '\\' | '|' => Some(28),
        ']' | '}' => Some(29),
        '^' | '~' => Some(30),
        '_' => Some(31),
        '?' => Some(127),
        _ => None,
    }
}

fn modifier_parameter(modifiers: KeyModifiers) -> u8 {
    1 + u8::from(modifiers.contains(KeyModifiers::SHIFT))
        + 2 * u8::from(modifiers.contains(KeyModifiers::ALT))
        + 4 * u8::from(modifiers.contains(KeyModifiers::CONTROL))
}

fn cursor_sequence(
    final_byte: u8,
    modifiers: KeyModifiers,
    application_cursor: bool,
) -> &'static [u8] {
    if modifiers.intersects(KeyModifiers::SHIFT | KeyModifiers::ALT | KeyModifiers::CONTROL) {
        return match (final_byte, modifier_parameter(modifiers)) {
            (b'A', 2) => b"\x1b[1;2A",
            (b'B', 2) => b"\x1b[1;2B",
            (b'C', 2) => b"\x1b[1;2C",
            (b'D', 2) => b"\x1b[1;2D",
            (b'A', 3) => b"\x1b[1;3A",
            (b'B', 3) => b"\x1b[1;3B",
            (b'C', 3) => b"\x1b[1;3C",
            (b'D', 3) => b"\x1b[1;3D",
            (b'A', 4) => b"\x1b[1;4A",
            (b'B', 4) => b"\x1b[1;4B",
            (b'C', 4) => b"\x1b[1;4C",
            (b'D', 4) => b"\x1b[1;4D",
            (b'A', 5) => b"\x1b[1;5A",
            (b'B', 5) => b"\x1b[1;5B",
            (b'C', 5) => b"\x1b[1;5C",
            (b'D', 5) => b"\x1b[1;5D",
            (b'A', 6) => b"\x1b[1;6A",
            (b'B', 6) => b"\x1b[1;6B",
            (b'C', 6) => b"\x1b[1;6C",
            (b'D', 6) => b"\x1b[1;6D",
            (b'A', 7) => b"\x1b[1;7A",
            (b'B', 7) => b"\x1b[1;7B",
            (b'C', 7) => b"\x1b[1;7C",
            (b'D', 7) => b"\x1b[1;7D",
            (b'A', 8) => b"\x1b[1;8A",
            (b'B', 8) => b"\x1b[1;8B",
            (b'C', 8) => b"\x1b[1;8C",
            (b'D', 8) => b"\x1b[1;8D",
            _ => b"",
        };
    }
    match (final_byte, application_cursor) {
        (b'A', true) => b"\x1bOA",
        (b'B', true) => b"\x1bOB",
        (b'C', true) => b"\x1bOC",
        (b'D', true) => b"\x1bOD",
        (b'A', false) => b"\x1b[A",
        (b'B', false) => b"\x1b[B",
        (b'C', false) => b"\x1b[C",
        (b'D', false) => b"\x1b[D",
        _ => b"",
    }
}

fn csi_tilde_or_cursor(final_byte: u8, number: u8, modifiers: KeyModifiers) -> Vec<u8> {
    if modifiers.intersects(KeyModifiers::SHIFT | KeyModifiers::ALT | KeyModifiers::CONTROL) {
        format!(
            "\x1b[1;{}{}",
            modifier_parameter(modifiers),
            char::from(final_byte)
        )
        .into_bytes()
    } else if matches!(final_byte, b'H' | b'F') {
        vec![0x1b, b'[', final_byte]
    } else {
        csi_tilde(number, modifiers).into_bytes()
    }
}

fn csi_tilde(number: u8, modifiers: KeyModifiers) -> String {
    if modifiers.intersects(KeyModifiers::SHIFT | KeyModifiers::ALT | KeyModifiers::CONTROL) {
        format!("\x1b[{number};{}~", modifier_parameter(modifiers))
    } else {
        format!("\x1b[{number}~")
    }
}

fn function_key(number: u8, modifiers: KeyModifiers) -> String {
    let suffix = match number {
        1 => "P",
        2 => "Q",
        3 => "R",
        4 => "S",
        5 => "15~",
        6 => "17~",
        7 => "18~",
        8 => "19~",
        9 => "20~",
        10 => "21~",
        11 => "23~",
        12 => "24~",
        _ => return String::new(),
    };
    let modified =
        modifiers.intersects(KeyModifiers::SHIFT | KeyModifiers::ALT | KeyModifiers::CONTROL);
    if number <= 4 {
        if modified {
            format!("\x1b[1;{}{suffix}", modifier_parameter(modifiers))
        } else {
            format!("\x1bO{suffix}")
        }
    } else if modified {
        format!(
            "\x1b[{};{}~",
            suffix.trim_end_matches('~'),
            modifier_parameter(modifiers)
        )
    } else {
        format!("\x1b[{suffix}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn shell_keys_encode_terminal_control_and_navigation_sequences() {
        assert_eq!(
            key_bytes(
                KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
                false
            ),
            vec![3]
        );
        assert_eq!(
            key_bytes(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE), false),
            b"\x1b[A"
        );
        assert_eq!(
            key_bytes(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE), true),
            b"\x1bOA"
        );
        assert_eq!(
            key_bytes(KeyEvent::new(KeyCode::Right, KeyModifiers::CONTROL), false),
            b"\x1b[1;5C"
        );
        assert_eq!(
            key_bytes(KeyEvent::new(KeyCode::Char('λ'), KeyModifiers::NONE), false),
            "λ".as_bytes()
        );
    }

    #[test]
    fn vt_colors_preserve_indexed_and_truecolor_output() {
        assert_eq!(vt_color(vt100::Color::Default, Color::Gray), Color::Gray);
        assert_eq!(
            vt_color(vt100::Color::Idx(208), Color::Reset),
            Color::Indexed(208)
        );
        assert_eq!(
            vt_color(vt100::Color::Rgb(12, 34, 56), Color::Reset),
            Color::Rgb(12, 34, 56)
        );
    }

    #[test]
    #[ignore = "manual PTY integration smoke test"]
    fn embedded_shell_executes_a_command_through_the_pty() {
        let mut shell = EmbeddedShell::spawn(Path::new(env!("CARGO_MANIFEST_DIR")))
            .expect("embedded shell should start");
        shell.send_paste("printf '\\nMORPHZ_PTY_READY\\n'");
        shell.send_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            shell.poll();
            if shell
                .parser
                .screen()
                .contents()
                .contains("MORPHZ_PTY_READY")
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!(
            "shell command did not reach the PTY screen: {}",
            shell.parser.screen().contents()
        );
    }
}
