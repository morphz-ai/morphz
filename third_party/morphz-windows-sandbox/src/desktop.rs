use crate::allow::compute_allow_paths_for_permissions;
use crate::deny_read_acl::plan_deny_read_acl_paths;
use crate::logging;
use crate::path_normalization::canonicalize_path;
use crate::resolved_permissions::ResolvedWindowsSandboxPermissions;
use crate::setup::SandboxSetupRequest;
use crate::setup::SetupRootOverrides;
use crate::setup::build_payload_deny_write_paths;
use crate::setup::build_payload_roots;
use crate::setup::gather_read_roots;
use crate::spawn_prep::LegacySessionSecurity;
use crate::token::get_current_token_for_restriction;
use crate::token::get_logon_sid_bytes;
use crate::token::get_user_sid_bytes;
use crate::winutil::format_last_error;
use crate::winutil::resolve_sid;
use crate::winutil::sid_bytes_from_string;
use crate::winutil::string_from_sid_bytes;
use crate::winutil::to_wide;
use anyhow::Result;
use rand::Rng;
use rand::SeedableRng;
use rand::rngs::SmallRng;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::ffi::c_void;
use std::path::Path;
use std::path::PathBuf;
use std::ptr;
use std::sync::Mutex;
use std::sync::OnceLock;
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;
use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Foundation::HLOCAL;
use windows_sys::Win32::Foundation::HMODULE;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
use windows_sys::Win32::Security::Authorization::EXPLICIT_ACCESS_W;
use windows_sys::Win32::Security::Authorization::GRANT_ACCESS;
use windows_sys::Win32::Security::Authorization::SE_WINDOW_OBJECT;
use windows_sys::Win32::Security::Authorization::SetEntriesInAclW;
use windows_sys::Win32::Security::Authorization::SetSecurityInfo;
use windows_sys::Win32::Security::Authorization::TRUSTEE_IS_SID;
use windows_sys::Win32::Security::Authorization::TRUSTEE_IS_UNKNOWN;
use windows_sys::Win32::Security::Authorization::TRUSTEE_W;
use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
use windows_sys::Win32::Security::PSECURITY_DESCRIPTOR;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::LibraryLoader::GetProcAddress;
use windows_sys::Win32::System::LibraryLoader::LoadLibraryW;
use windows_sys::Win32::System::StationsAndDesktops::DESKTOP_CREATEMENU;
use windows_sys::Win32::System::StationsAndDesktops::DESKTOP_CREATEWINDOW;
use windows_sys::Win32::System::StationsAndDesktops::DESKTOP_DELETE;
use windows_sys::Win32::System::StationsAndDesktops::DESKTOP_ENUMERATE;
use windows_sys::Win32::System::StationsAndDesktops::DESKTOP_HOOKCONTROL;
use windows_sys::Win32::System::StationsAndDesktops::DESKTOP_JOURNALPLAYBACK;
use windows_sys::Win32::System::StationsAndDesktops::DESKTOP_JOURNALRECORD;
use windows_sys::Win32::System::StationsAndDesktops::DESKTOP_READ_CONTROL;
use windows_sys::Win32::System::StationsAndDesktops::DESKTOP_READOBJECTS;
use windows_sys::Win32::System::StationsAndDesktops::DESKTOP_SWITCHDESKTOP;
use windows_sys::Win32::System::StationsAndDesktops::DESKTOP_WRITE_DAC;
use windows_sys::Win32::System::StationsAndDesktops::DESKTOP_WRITE_OWNER;
use windows_sys::Win32::System::StationsAndDesktops::DESKTOP_WRITEOBJECTS;

const PRIVATE_DESKTOP_PREFIX: &str = "MorphzSandboxDesktop-";
const PRIVATE_WINDOW_STATION_PREFIX: &str = "MorphzSandboxStation-";

const DESKTOP_ALL_ACCESS: u32 = DESKTOP_READOBJECTS
    | DESKTOP_CREATEWINDOW
    | DESKTOP_CREATEMENU
    | DESKTOP_HOOKCONTROL
    | DESKTOP_JOURNALRECORD
    | DESKTOP_JOURNALPLAYBACK
    | DESKTOP_ENUMERATE
    | DESKTOP_WRITEOBJECTS
    | DESKTOP_SWITCHDESKTOP
    | DESKTOP_DELETE
    | DESKTOP_READ_CONTROL
    | DESKTOP_WRITE_DAC
    | DESKTOP_WRITE_OWNER;

const DESKTOP_PARTICIPANT_ACCESS: u32 =
    DESKTOP_ALL_ACCESS & !(DESKTOP_WRITE_DAC | DESKTOP_WRITE_OWNER | DESKTOP_DELETE);

// A sandbox-owned private Window Station is not shared with the user's interactive or service
// desktop. Granting its two participants full control is therefore safe and lets USER32/CLR
// initialize without widening access on the host process's Window Station.
const WINDOW_STATION_ALL_ACCESS: u32 = 0x000f_037f;

type DesktopCacheKey = (String, String, DesktopPolicy);
type SharedDesktopCache<T> = OnceLock<Mutex<HashMap<DesktopCacheKey, T>>>;

static SHARED_PRIVATE_DESKTOPS: SharedDesktopCache<PrivateDesktop> = OnceLock::new();
static SHARED_ELEVATED_PRIVATE_DESKTOPS: SharedDesktopCache<ElevatedPrivateDesktop> =
    OnceLock::new();
static WINDOW_STATION_SWITCH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

type CloseDesktopFn = unsafe extern "system" fn(isize) -> i32;
type CloseWindowStationFn = unsafe extern "system" fn(isize) -> i32;
type CreateDesktopWFn = unsafe extern "system" fn(
    *const u16,
    *const u16,
    *const c_void,
    u32,
    u32,
    *const SECURITY_ATTRIBUTES,
) -> isize;
type CreateWindowStationWFn =
    unsafe extern "system" fn(*const u16, u32, u32, *const SECURITY_ATTRIBUTES) -> isize;
type OpenDesktopWFn = unsafe extern "system" fn(*const u16, u32, i32, u32) -> isize;
type GetProcessWindowStationFn = unsafe extern "system" fn() -> isize;
type GetUserObjectInformationWFn =
    unsafe extern "system" fn(isize, i32, *mut c_void, u32, *mut u32) -> i32;
type SetProcessWindowStationFn = unsafe extern "system" fn(isize) -> i32;

// winuser.h constant omitted by windows-sys 0.52.
const UOI_NAME: i32 = 2;

struct User32DesktopApi {
    _module: HMODULE,
    close_desktop: CloseDesktopFn,
    close_window_station: CloseWindowStationFn,
    create_desktop: CreateDesktopWFn,
    create_window_station: CreateWindowStationWFn,
    get_process_window_station: GetProcessWindowStationFn,
    get_user_object_information: GetUserObjectInformationWFn,
    open_desktop: OpenDesktopWFn,
    set_process_window_station: SetProcessWindowStationFn,
}

fn user32_desktop_api() -> Result<&'static User32DesktopApi> {
    static API: OnceLock<std::result::Result<User32DesktopApi, String>> = OnceLock::new();
    API.get_or_init(|| unsafe {
        let module = LoadLibraryW(to_wide("user32.dll").as_ptr());
        if module == 0 {
            return Err(format!(
                "LoadLibraryW(user32.dll) failed: {}",
                GetLastError()
            ));
        }

        unsafe fn resolve<T>(
            module: HMODULE,
            name: &'static [u8],
        ) -> std::result::Result<T, String> {
            let proc = GetProcAddress(module, name.as_ptr()).ok_or_else(|| {
                format!(
                    "GetProcAddress({}) failed: {}",
                    String::from_utf8_lossy(&name[..name.len().saturating_sub(1)]),
                    GetLastError()
                )
            })?;
            // Every alias used below is a Win32 function pointer. FARPROC and those pointers
            // have the same representation on supported Windows targets.
            Ok(std::mem::transmute_copy(&proc))
        }

        Ok(User32DesktopApi {
            _module: module,
            close_desktop: resolve(module, b"CloseDesktop\0")?,
            close_window_station: resolve(module, b"CloseWindowStation\0")?,
            create_desktop: resolve(module, b"CreateDesktopW\0")?,
            create_window_station: resolve(module, b"CreateWindowStationW\0")?,
            get_process_window_station: resolve(module, b"GetProcessWindowStation\0")?,
            get_user_object_information: resolve(module, b"GetUserObjectInformationW\0")?,
            open_desktop: resolve(module, b"OpenDesktopW\0")?,
            set_process_window_station: resolve(module, b"SetProcessWindowStation\0")?,
        })
    })
    .as_ref()
    .map_err(|message| anyhow::anyhow!(message.clone()))
}

fn current_window_station_name() -> Result<String> {
    let api = user32_desktop_api()?;
    let window_station = unsafe { (api.get_process_window_station)() };
    if window_station == 0 {
        anyhow::bail!("GetProcessWindowStation failed: {}", unsafe {
            GetLastError()
        });
    }

    let mut needed_bytes = 0;
    unsafe {
        (api.get_user_object_information)(
            window_station,
            UOI_NAME,
            ptr::null_mut(),
            0,
            &mut needed_bytes,
        );
    }
    if needed_bytes < 2 {
        anyhow::bail!("GetUserObjectInformationW returned an invalid station-name length");
    }
    let mut name = vec![0u16; (needed_bytes as usize).div_ceil(std::mem::size_of::<u16>())];
    if unsafe {
        (api.get_user_object_information)(
            window_station,
            UOI_NAME,
            name.as_mut_ptr().cast(),
            needed_bytes,
            &mut needed_bytes,
        )
    } == 0
    {
        anyhow::bail!("GetUserObjectInformationW failed: {}", unsafe {
            GetLastError()
        });
    }
    let end = name
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(name.len());
    let name = String::from_utf16(&name[..end])?;
    if name.is_empty()
        || name.contains('\\')
        || name.contains('/')
        || name.chars().any(char::is_control)
    {
        anyhow::bail!("GetUserObjectInformationW returned an invalid station name");
    }
    Ok(name)
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct DesktopPolicy {
    uses_write_capabilities: bool,
    capability_sids: BTreeSet<Vec<u8>>,
    network_enabled: bool,
    network_proxy_restricting_sid: Option<Vec<u8>>,
    // None denotes the legacy backend's unrestricted reads and different desktop ACLs.
    read_roots: Option<BTreeSet<PathBuf>>,
    write_roots: BTreeSet<PathBuf>,
    deny_read_paths: BTreeSet<PathBuf>,
    deny_write_paths: BTreeSet<PathBuf>,
}

impl DesktopPolicy {
    pub(crate) fn elevated(
        request: SandboxSetupRequest<'_>,
        mut overrides: SetupRootOverrides,
        capability_sids: &[String],
        network_proxy_restricting_sid: Option<&str>,
    ) -> Result<Self> {
        // Match the complete read override passed by credential setup to the ACL helper.
        overrides.read_roots.get_or_insert_with(|| {
            gather_read_roots(
                request.command_cwd,
                request.permissions,
                request.env_map,
                request.codex_home,
            )
        });
        let (read_roots, write_roots) = build_payload_roots(&request, &overrides);
        Ok(Self {
            uses_write_capabilities: request
                .permissions
                .uses_write_capabilities_for_cwd(request.command_cwd, request.env_map),
            capability_sids: capability_sids
                .iter()
                .map(|sid| sid_bytes_from_string(sid))
                .collect::<Result<_>>()?,
            network_enabled: request.permissions.network_policy().is_enabled(),
            network_proxy_restricting_sid: network_proxy_restricting_sid
                .map(sid_bytes_from_string)
                .transpose()?,
            read_roots: Some(read_roots.into_iter().collect()),
            write_roots: write_roots.into_iter().collect(),
            deny_read_paths: plan_deny_read_acl_paths(
                overrides.deny_read_paths.as_deref().unwrap_or_default(),
            )
            .into_iter()
            .collect(),
            deny_write_paths: build_payload_deny_write_paths(&request, overrides.deny_write_paths)
                .into_iter()
                .map(|path| canonicalize_path(&path))
                .collect(),
        })
    }
}

pub struct LaunchDesktop {
    _private_desktop: Option<PrivateDesktop>,
    startup_name: Vec<u16>,
}

impl LaunchDesktop {
    fn validate_private_name(name: &str) -> Result<()> {
        if !name
            .strip_prefix(PRIVATE_DESKTOP_PREFIX)
            .is_some_and(|nonce| {
                !nonce.is_empty()
                    && nonce.len() <= 32
                    && nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        {
            anyhow::bail!("invalid private desktop name");
        }
        Ok(())
    }

    fn validate_private_path(path: &str) -> Result<()> {
        let mut parts = path.split('\\');
        let station = parts.next().unwrap_or_default();
        let desktop = parts.next().unwrap_or_default();
        if station.is_empty()
            || station.contains('/')
            || station.chars().any(char::is_control)
            || parts.next().is_some()
        {
            anyhow::bail!("invalid private desktop path");
        }
        Self::validate_private_name(desktop)
    }

    pub(crate) fn prepare_legacy(
        use_private_desktop: bool,
        permissions: &ResolvedWindowsSandboxPermissions,
        cwd: &Path,
        env: &HashMap<String, String>,
        security: &LegacySessionSecurity,
        additional_deny_write_paths: &[PathBuf],
        logs_base_dir: Option<&Path>,
    ) -> Result<Self> {
        if !use_private_desktop {
            return Self::prepare(/*use_private_desktop*/ false, logs_base_dir);
        }
        let sandbox_sid = unsafe { get_user_sid_bytes(security.h_token)? };
        let sandbox_sid = string_from_sid_bytes(&sandbox_sid).map_err(anyhow::Error::msg)?;
        let paths = compute_allow_paths_for_permissions(permissions, cwd, env);
        let policy = DesktopPolicy {
            uses_write_capabilities: security.readonly_sid.is_none(),
            capability_sids: security
                .readonly_sid_str
                .iter()
                .chain(security.write_root_sids.iter().map(|root| &root.sid_str))
                .map(|sid| sid_bytes_from_string(sid))
                .collect::<Result<_>>()?,
            network_enabled: permissions.network_policy().is_enabled(),
            network_proxy_restricting_sid: None,
            read_roots: None,
            write_roots: paths.allow.into_iter().collect(),
            deny_read_paths: BTreeSet::new(),
            deny_write_paths: paths
                .deny
                .into_iter()
                .chain(additional_deny_write_paths.iter().cloned())
                .map(|path| canonicalize_path(&path))
                .collect(),
        };
        let mut desktops = SHARED_PRIVATE_DESKTOPS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| anyhow::anyhow!("shared private desktop cache was poisoned"))?;
        let desktop = match desktops.entry((current_window_station_name()?, sandbox_sid, policy)) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(PrivateDesktop::create(logs_base_dir)?)
            }
        };
        Self::open_private(&desktop.name)
    }

    pub fn prepare(use_private_desktop: bool, logs_base_dir: Option<&Path>) -> Result<Self> {
        if use_private_desktop {
            let private_desktop = PrivateDesktop::create(logs_base_dir)?;
            let startup_name = to_wide(private_desktop.startup_path());
            Ok(Self {
                _private_desktop: Some(private_desktop),
                startup_name,
            })
        } else {
            Ok(Self {
                _private_desktop: None,
                startup_name: to_wide("Winsta0\\Default"),
            })
        }
    }

    /// Opens the caller-owned private desktop without creating one or falling back to Default.
    pub fn open_private(name: &str) -> Result<Self> {
        Self::validate_private_name(name)?;
        let window_station_name = current_window_station_name()?;
        let name_wide = to_wide(name);
        let api = user32_desktop_api()?;
        let handle = unsafe {
            (api.open_desktop)(
                name_wide.as_ptr(),
                /*dwflags*/ 0,
                /*finherit*/ 0,
                DESKTOP_PARTICIPANT_ACCESS,
            )
        };
        if handle == 0 {
            anyhow::bail!("OpenDesktopW failed: {}", unsafe { GetLastError() });
        }
        Ok(Self {
            _private_desktop: Some(PrivateDesktop {
                handle,
                name: name.to_owned(),
                window_station_name: window_station_name.clone(),
            }),
            startup_name: to_wide(format!("{window_station_name}\\{name}")),
        })
    }

    /// References a parent-owned private desktop without linking USER32 into the caller.
    ///
    /// The elevated command runner is launched under a separate local account. Importing USER32
    /// in that bootstrap process makes the Windows loader initialize a GUI connection before
    /// Rust `main`; from a non-interactive OpenSSH host that can fail with 0xC0000142 before the
    /// named-pipe handshake. The parent Runtime owns the desktop handle in the shared desktop
    /// cache for at least as long as the runner, so the runner only needs the validated startup
    /// name when it creates the actual restricted child process.
    pub fn reference_parent_owned_private(path: &str) -> Result<Self> {
        Self::validate_private_path(path)?;
        Ok(Self {
            _private_desktop: None,
            startup_name: to_wide(path),
        })
    }

    /// References the default desktop without opening it in the bootstrap runner.
    pub fn reference_default() -> Self {
        Self {
            _private_desktop: None,
            startup_name: to_wide("Winsta0\\Default"),
        }
    }

    pub fn startup_info_desktop(&self) -> *mut u16 {
        self.startup_name.as_ptr() as *mut u16
    }
}

/// Reuses a private desktop only for the same sandbox account and effective permissions.
pub(crate) fn shared_private_desktop_for_user(
    sandbox_username: &str,
    policy: &DesktopPolicy,
    logs_base_dir: Option<&Path>,
) -> Result<String> {
    let window_station_name = current_window_station_name()?;
    let sandbox_sid_bytes = resolve_sid(sandbox_username)?;
    let sandbox_sid = string_from_sid_bytes(&sandbox_sid_bytes).map_err(anyhow::Error::msg)?;
    let mut desktops = SHARED_ELEVATED_PRIVATE_DESKTOPS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| anyhow::anyhow!("shared elevated private desktop cache was poisoned"))?;
    let key = (
        window_station_name.clone(),
        sandbox_sid.clone(),
        policy.clone(),
    );
    if let Some(desktop) = desktops.get(&key) {
        return Ok(desktop.startup_path());
    }

    let owner_user_sid = unsafe {
        let token = get_current_token_for_restriction()?;
        let sid = get_user_sid_bytes(token);
        CloseHandle(token);
        sid?
    };
    let owner_user_sid = string_from_sid_bytes(&owner_user_sid).map_err(anyhow::Error::msg)?;
    let desktop = match PrivateWindowStationDesktop::create(
        &owner_user_sid,
        &sandbox_sid,
        logs_base_dir,
    ) {
        Ok(desktop) => ElevatedPrivateDesktop::PrivateWindowStation(desktop),
        Err(error) if is_private_window_station_access_denied(&error) => {
            // Ordinary interactive users can be denied CREATEWINSTA by local policy even though
            // they are allowed to create a private Desktop inside their existing Window Station.
            // Keep GUI objects away from the visible Default desktop instead of requiring the
            // entire Runtime to run as administrator or dropping desktop isolation altogether.
            logging::debug_log(
                "CreateWindowStationW was denied; using a private Desktop in the current Window Station",
                logs_base_dir,
            );
            ElevatedPrivateDesktop::CurrentWindowStation(PrivateDesktop::create(logs_base_dir)?)
        }
        Err(error) => return Err(error),
    };
    let startup_path = desktop.startup_path();
    // Retain the isolation objects across runner exits and idle gaps. Each effective policy
    // receives its own Desktop. The preferred private Window Station also separates clipboard
    // and atom-table state; the compatibility path shares those station-level resources.
    desktops.insert(key, desktop);
    Ok(startup_path)
}

enum ElevatedPrivateDesktop {
    PrivateWindowStation(PrivateWindowStationDesktop),
    CurrentWindowStation(PrivateDesktop),
}

impl ElevatedPrivateDesktop {
    fn startup_path(&self) -> String {
        match self {
            Self::PrivateWindowStation(desktop) => desktop.startup_path(),
            Self::CurrentWindowStation(desktop) => desktop.startup_path(),
        }
    }
}

#[derive(Debug)]
struct PrivateWindowStationAccessDenied(u32);

impl std::fmt::Display for PrivateWindowStationAccessDenied {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "CreateWindowStationW failed for private station: {}",
            self.0
        )
    }
}

impl std::error::Error for PrivateWindowStationAccessDenied {}

fn is_private_window_station_access_denied(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<PrivateWindowStationAccessDenied>()
        .is_some()
}

struct LocalSecurityDescriptor(PSECURITY_DESCRIPTOR);

impl LocalSecurityDescriptor {
    fn for_participants(access: u32, owner_sid: &str, sandbox_sid: &str) -> Result<Self> {
        // CreateProcessWithLogonW shares the caller's logon SID with the sandbox account. Grant
        // ACL-management rights to the caller's stable user SID instead.
        // https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw
        let sddl = to_wide(format!(
            "D:P(A;;0x{access:x};;;{owner_sid})(A;;0x{access:x};;;{sandbox_sid})"
        ));
        let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                /*stringsdrevision*/ 1,
                &mut descriptor,
                ptr::null_mut(),
            )
        } == 0
        {
            anyhow::bail!(
                "ConvertStringSecurityDescriptorToSecurityDescriptorW failed: {}",
                unsafe { GetLastError() }
            );
        }
        Ok(Self(descriptor))
    }

    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        }
    }
}

impl Drop for LocalSecurityDescriptor {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0 as HLOCAL);
            }
        }
    }
}

struct PrivateWindowStationDesktop {
    window_station_handle: isize,
    desktop_handle: isize,
    window_station_name: String,
    desktop_name: String,
}

impl PrivateWindowStationDesktop {
    fn create(owner_sid: &str, sandbox_sid: &str, logs_base_dir: Option<&Path>) -> Result<Self> {
        let station_security = LocalSecurityDescriptor::for_participants(
            WINDOW_STATION_ALL_ACCESS,
            owner_sid,
            sandbox_sid,
        )?;
        let desktop_security =
            LocalSecurityDescriptor::for_participants(DESKTOP_ALL_ACCESS, owner_sid, sandbox_sid)?;
        let station_attributes = station_security.attributes();
        let desktop_attributes = desktop_security.attributes();
        let mut rng = SmallRng::from_entropy();
        let window_station_name = format!(
            "{PRIVATE_WINDOW_STATION_PREFIX}{:032x}",
            rng.r#gen::<u128>()
        );
        let desktop_name = format!("{PRIVATE_DESKTOP_PREFIX}{:032x}", rng.r#gen::<u128>());
        let window_station_name_wide = to_wide(&window_station_name);
        let desktop_name_wide = to_wide(&desktop_name);
        let api = user32_desktop_api()?;
        let switch_guard = WINDOW_STATION_SWITCH_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| anyhow::anyhow!("window-station switch lock was poisoned"))?;

        let window_station_handle = unsafe {
            (api.create_window_station)(
                window_station_name_wide.as_ptr(),
                /*dwflags*/ 0,
                WINDOW_STATION_ALL_ACCESS,
                &station_attributes,
            )
        };
        if window_station_handle == 0 {
            let error = unsafe { GetLastError() };
            logging::debug_log(
                &format!("CreateWindowStationW failed for private station: {error}"),
                logs_base_dir,
            );
            if error == ERROR_ACCESS_DENIED {
                return Err(PrivateWindowStationAccessDenied(error).into());
            }
            anyhow::bail!("CreateWindowStationW failed for private station: {error}");
        }

        let original_window_station = unsafe { (api.get_process_window_station)() };
        if original_window_station == 0 {
            let error = unsafe { GetLastError() };
            unsafe {
                let _ = (api.close_window_station)(window_station_handle);
            }
            anyhow::bail!("GetProcessWindowStation failed: {error}");
        }
        if unsafe { (api.set_process_window_station)(window_station_handle) } == 0 {
            let error = unsafe { GetLastError() };
            unsafe {
                let _ = (api.close_window_station)(window_station_handle);
            }
            anyhow::bail!("SetProcessWindowStation(private) failed: {error}");
        }

        // CreateDesktopW always targets the caller's current Window Station. No fallible Rust
        // operation may run between the switch and restoration.
        let desktop_handle = unsafe {
            (api.create_desktop)(
                desktop_name_wide.as_ptr(),
                ptr::null(),
                ptr::null_mut(),
                /*dwflags*/ 0,
                DESKTOP_ALL_ACCESS,
                &desktop_attributes,
            )
        };
        let create_desktop_error = unsafe { GetLastError() };
        let restored = unsafe { (api.set_process_window_station)(original_window_station) };
        let restore_error = unsafe { GetLastError() };
        drop(switch_guard);

        if restored == 0 {
            // The process is still attached to this station, so closing it would be unsafe. The
            // operating system will reclaim these handles when the Runtime exits.
            logging::debug_log(
                &format!("SetProcessWindowStation(restore) failed: {restore_error}"),
                logs_base_dir,
            );
            anyhow::bail!("SetProcessWindowStation(restore) failed: {restore_error}");
        }
        if desktop_handle == 0 {
            unsafe {
                let _ = (api.close_window_station)(window_station_handle);
            }
            logging::debug_log(
                &format!(
                    "CreateDesktopW failed for private Window Station: {create_desktop_error}"
                ),
                logs_base_dir,
            );
            anyhow::bail!(
                "CreateDesktopW failed for private Window Station: {create_desktop_error}"
            );
        }

        Ok(Self {
            window_station_handle,
            desktop_handle,
            window_station_name,
            desktop_name,
        })
    }

    fn startup_path(&self) -> String {
        format!("{}\\{}", self.window_station_name, self.desktop_name)
    }
}

impl Drop for PrivateWindowStationDesktop {
    fn drop(&mut self) {
        unsafe {
            if let Ok(api) = user32_desktop_api() {
                if self.desktop_handle != 0 {
                    let _ = (api.close_desktop)(self.desktop_handle);
                }
                if self.window_station_handle != 0 {
                    let _ = (api.close_window_station)(self.window_station_handle);
                }
            }
        }
    }
}

struct PrivateDesktop {
    handle: isize,
    name: String,
    window_station_name: String,
}

impl PrivateDesktop {
    fn create(logs_base_dir: Option<&Path>) -> Result<Self> {
        let window_station_name = current_window_station_name()?;
        let mut rng = SmallRng::from_entropy();
        let name = format!("MorphzSandboxDesktop-{:x}", rng.r#gen::<u128>());
        let name_wide = to_wide(&name);
        let api = user32_desktop_api()?;
        let handle = unsafe {
            (api.create_desktop)(
                name_wide.as_ptr(),
                ptr::null(),
                ptr::null_mut(),
                0,
                DESKTOP_ALL_ACCESS,
                ptr::null_mut(),
            )
        };
        if handle == 0 {
            let err = unsafe { GetLastError() } as i32;
            logging::debug_log(
                &format!(
                    "CreateDesktopW failed for {name}: {} ({})",
                    err,
                    format_last_error(err),
                ),
                logs_base_dir,
            );
            return Err(anyhow::anyhow!("CreateDesktopW failed: {err}"));
        }

        unsafe {
            if let Err(err) = grant_desktop_access(handle, logs_base_dir) {
                let _ = (api.close_desktop)(handle);
                return Err(err);
            }
        }

        Ok(Self {
            handle,
            name,
            window_station_name,
        })
    }

    fn startup_path(&self) -> String {
        format!("{}\\{}", self.window_station_name, self.name)
    }
}

unsafe fn grant_desktop_access(handle: isize, logs_base_dir: Option<&Path>) -> Result<()> {
    let token = get_current_token_for_restriction()?;
    let mut logon_sid = get_logon_sid_bytes(token)?;
    CloseHandle(token);

    let entries = [EXPLICIT_ACCESS_W {
        grfAccessPermissions: DESKTOP_ALL_ACCESS,
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: 0,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: ptr::null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: logon_sid.as_mut_ptr() as *mut c_void as *mut u16,
        },
    }];

    let mut updated_dacl = ptr::null_mut();
    let set_entries_code = SetEntriesInAclW(
        entries.len() as u32,
        entries.as_ptr(),
        ptr::null_mut(),
        &mut updated_dacl,
    );
    if set_entries_code != ERROR_SUCCESS {
        logging::debug_log(
            &format!("SetEntriesInAclW failed for private desktop: {set_entries_code}"),
            logs_base_dir,
        );
        return Err(anyhow::anyhow!(
            "SetEntriesInAclW failed for private desktop: {set_entries_code}"
        ));
    }

    let set_security_code = SetSecurityInfo(
        handle,
        SE_WINDOW_OBJECT,
        DACL_SECURITY_INFORMATION,
        ptr::null_mut(),
        ptr::null_mut(),
        updated_dacl,
        ptr::null_mut(),
    );
    if !updated_dacl.is_null() {
        LocalFree(updated_dacl as HLOCAL);
    }
    if set_security_code != ERROR_SUCCESS {
        logging::debug_log(
            &format!("SetSecurityInfo failed for private desktop: {set_security_code}"),
            logs_base_dir,
        );
        return Err(anyhow::anyhow!(
            "SetSecurityInfo failed for private desktop: {set_security_code}"
        ));
    }

    Ok(())
}

impl Drop for PrivateDesktop {
    fn drop(&mut self) {
        unsafe {
            if self.handle != 0
                && let Ok(api) = user32_desktop_api()
            {
                let _ = (api.close_desktop)(self.handle);
            }
        }
    }
}

#[cfg(test)]
#[path = "desktop_tests.rs"]
mod tests;
