// Windows-only Node-API bridge. Job ownership lives in the Runner process.
// No helper process, inherited Job handle, breakaway permission or PID lookup.
#define WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0a00
#endif
#define NAPI_VERSION 8
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "node_api.h"

// Resolve the stable Node-API from the host, avoiding a versioned node.lib.
#define API_LIST(X) \
  X(napi_get_cb_info) X(napi_get_value_string_utf16) X(napi_get_buffer_info) \
  X(napi_create_object) X(napi_create_uint32) X(napi_get_null) \
  X(napi_set_named_property) X(napi_create_function) X(napi_get_undefined) \
  X(napi_throw_error) X(napi_throw_type_error) X(napi_wrap) X(napi_unwrap) \
  X(napi_type_tag_object) X(napi_check_object_type_tag)
#define DECLARE_API(name) static __typeof__(&name) api_##name;
API_LIST(DECLARE_API)
#define JS(name) api_##name
static INIT_ONCE api_once = INIT_ONCE_STATIC_INIT;
static const char *missing_api = NULL;

static BOOL CALLBACK load_api(PINIT_ONCE once, PVOID parameter, PVOID *context) {
  (void)once; (void)parameter; (void)context;
  HMODULE host = GetModuleHandleW(NULL);
#define LOAD_API(name) \
  do { \
    FARPROC address = GetProcAddress(host, #name); \
    _Static_assert(sizeof(api_##name) == sizeof(address), "Windows function pointer size"); \
    memcpy(&api_##name, &address, sizeof(address)); \
    if (!api_##name) missing_api = #name; \
  } while (0);
  API_LIST(LOAD_API)
  return TRUE;
}
typedef struct {
  HANDLE job;
  HANDLE root;
  DWORD pid;
  DWORD exit_code;
  BOOL exited;
} WebJob;

static const napi_type_tag job_tag = { 0x313acf861c2f451aULL, 0xa79bfe6e33494950ULL };

static napi_value win_error(napi_env env, const char *operation, DWORD code) {
  char message[192];
  snprintf(message, sizeof(message), "web_job_%s_failed: win32=%lu", operation, (unsigned long)code);
  JS(napi_throw_error)(env, "web_job_failed", message);
  return NULL;
}

static void release_handles(WebJob *job) {
  // Close the Job first: KILL_ON_JOB_CLOSE also protects every failure path.
  if (job->job) { CloseHandle(job->job); job->job = NULL; }
  if (job->root) { CloseHandle(job->root); job->root = NULL; }
}

static void finalize_job(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  WebJob *job = data;
  release_handles(job);
  free(job);
}

static wchar_t *read_string(napi_env env, napi_value value) {
  size_t length = 0;
  if (JS(napi_get_value_string_utf16)(env, value, NULL, 0, &length) != napi_ok) {
    JS(napi_throw_type_error)(env, NULL, "web_job_argument: expected a string");
    return NULL;
  }
  if (!length || length > 32767) {
    JS(napi_throw_type_error)(env, NULL, "web_job_argument: empty or oversized string");
    return NULL;
  }
  wchar_t *text = calloc(length + 1, sizeof(wchar_t));
  if (!text) { win_error(env, "allocate", ERROR_NOT_ENOUGH_MEMORY); return NULL; }
  if (JS(napi_get_value_string_utf16)(env, value, (char16_t *)text, length + 1, &length) != napi_ok) {
    free(text); return NULL;
  }
  if (wcslen(text) != length) {
    free(text);
    JS(napi_throw_type_error)(env, NULL, "web_job_argument: embedded NUL");
    return NULL;
  }
  return text;
}

static BOOL job_state(WebJob *job, DWORD *active) {
  *active = 0;
  if (!job->job) return TRUE;
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info = {0};
  if (!QueryInformationJobObject(job->job, JobObjectBasicAccountingInformation,
                                &info, sizeof(info), NULL)) return FALSE;
  *active = info.ActiveProcesses;
  if (!job->exited) {
    DWORD state = WaitForSingleObject(job->root, 0);
    if (state == WAIT_FAILED) return FALSE;
    if (state == WAIT_OBJECT_0) {
      if (!GetExitCodeProcess(job->root, &job->exit_code)) return FALSE;
      job->exited = TRUE;
    }
  }
  return TRUE;
}

static WebJob *read_job(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value value;
  bool matches = false;
  WebJob *job = NULL;
  if (JS(napi_get_cb_info)(env, info, &count, &value, NULL, NULL) != napi_ok) return NULL;
  if (count != 1 || JS(napi_check_object_type_tag)(env, value, &job_tag, &matches) != napi_ok || !matches) {
    JS(napi_throw_type_error)(env, NULL, "web_job_argument: invalid Job object");
    return NULL;
  }
  if (JS(napi_unwrap)(env, value, (void **)&job) != napi_ok) return NULL;
  return job;
}

typedef struct {
  HANDLE input;
  HANDLE log;
  LPPROC_THREAD_ATTRIBUTE_LIST attributes;
  BOOL attributes_initialized;
} LaunchResources;

static void release_launch(LaunchResources *resources) {
  if (resources->attributes_initialized) DeleteProcThreadAttributeList(resources->attributes);
  free(resources->attributes);
  if (resources->input && resources->input != INVALID_HANDLE_VALUE) CloseHandle(resources->input);
  if (resources->log && resources->log != INVALID_HANDLE_VALUE) CloseHandle(resources->log);
}

static BOOL prepare_launch(WebJob *job, LaunchResources *resources, const wchar_t *log_path,
                           STARTUPINFOEXW *startup) {
  SECURITY_ATTRIBUTES inherited = { sizeof(inherited), NULL, TRUE };
  resources->input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                 &inherited, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (resources->input == INVALID_HANDLE_VALUE) return FALSE;
  resources->log = CreateFileW(log_path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                               &inherited, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (resources->log == INVALID_HANDLE_VALUE) return FALSE;
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(NULL, 2, 0, &size);
  if (!size) return FALSE;
  resources->attributes = malloc(size);
  if (!resources->attributes) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); return FALSE; }
  if (!InitializeProcThreadAttributeList(resources->attributes, 2, 0, &size)) return FALSE;
  resources->attributes_initialized = TRUE;
  if (!UpdateProcThreadAttribute(resources->attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                 &job->job, sizeof(job->job), NULL, NULL)) return FALSE;
  startup->StartupInfo.cb = sizeof(*startup);
  startup->StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup->StartupInfo.hStdInput = resources->input;
  startup->StartupInfo.hStdOutput = resources->log;
  startup->StartupInfo.hStdError = resources->log;
  startup->lpAttributeList = resources->attributes;
  return TRUE;
}

static BOOL create_root(WebJob *job, wchar_t **strings, void *environment,
                         LaunchResources *resources) {
  STARTUPINFOEXW startup = {0};
  if (!prepare_launch(job, resources, strings[3], &startup)) return FALSE;
  HANDLE handles[] = { resources->input, resources->log };
  if (!UpdateProcThreadAttribute(resources->attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                 handles, sizeof(handles), NULL, NULL)) return FALSE;
  PROCESS_INFORMATION process = {0};
  if (!CreateProcessW(strings[0], strings[1], NULL, NULL, TRUE,
                      EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                      environment, strings[2], &startup.StartupInfo, &process)) return FALSE;
  job->root = process.hProcess;
  job->pid = process.dwProcessId;
  CloseHandle(process.hThread);
  return TRUE;
}

static napi_value launch(napi_env env, napi_callback_info info) {
  napi_value args[5], result = NULL, pid;
  size_t count = 5, environment_size = 0;
  wchar_t *strings[4] = {0};
  void *environment = NULL;
  WebJob *job = NULL;
  LaunchResources resources = {0};
  if (JS(napi_get_cb_info)(env, info, &count, args, NULL, NULL) != napi_ok) return NULL;
  if (count != 5) { JS(napi_throw_type_error)(env, NULL, "web_job_argument: expected five arguments"); return NULL; }
  for (size_t i = 0; i < 4; i++) if (!(strings[i] = read_string(env, args[i]))) goto done;
  if (JS(napi_get_buffer_info)(env, args[4], &environment, &environment_size) != napi_ok ||
      environment_size < 4 || environment_size % 2 ||
      ((wchar_t *)environment)[environment_size / 2 - 1] ||
      ((wchar_t *)environment)[environment_size / 2 - 2]) {
    JS(napi_throw_type_error)(env, NULL, "web_job_argument: invalid UTF-16 environment block"); goto done;
  }
  job = calloc(1, sizeof(*job));
  if (!job) { win_error(env, "allocate", ERROR_NOT_ENOUGH_MEMORY); goto done; }
  // NULL security attributes: the Job handle is NOT inheritable or named.
  job->job = CreateJobObjectW(NULL, NULL);
  if (!job->job) { win_error(env, "create", GetLastError()); goto done; }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    win_error(env, "configure", GetLastError()); goto done;
  }
  if (!create_root(job, strings, environment, &resources)) {
    win_error(env, "launch", GetLastError()); goto done;
  }
  if (JS(napi_create_object)(env, &result) != napi_ok ||
      JS(napi_create_uint32)(env, job->pid, &pid) != napi_ok ||
      JS(napi_set_named_property)(env, result, "pid", pid) != napi_ok ||
      JS(napi_type_tag_object)(env, result, &job_tag) != napi_ok ||
      JS(napi_wrap)(env, result, job, finalize_job, NULL, NULL) != napi_ok) {
    result = NULL; goto done;
  }
  job = NULL; // Wrapped object owns both handles until close/finalization.
done:
  release_launch(&resources);
  for (size_t i = 0; i < 4; i++) free(strings[i]);
  if (job) { release_handles(job); free(job); }
  return result;
}

static napi_value poll_job(napi_env env, napi_callback_info info) {
  WebJob *job = read_job(env, info);
  if (!job) return NULL;
  DWORD active = 0;
  if (!job_state(job, &active)) return win_error(env, "query", GetLastError());
  napi_value result, value;
  if (JS(napi_create_object)(env, &result) != napi_ok) return NULL;
  if (JS(napi_create_uint32)(env, active, &value) != napi_ok ||
      JS(napi_set_named_property)(env, result, "active", value) != napi_ok) return NULL;
  napi_status status = job->exited ? JS(napi_create_uint32)(env, job->exit_code, &value) : JS(napi_get_null)(env, &value);
  if (status != napi_ok || JS(napi_set_named_property)(env, result, "code", value) != napi_ok) return NULL;
  return result;
}

static napi_value terminate_job(napi_env env, napi_callback_info info) {
  WebJob *job = read_job(env, info);
  if (!job) return NULL;
  if (job->job && !TerminateJobObject(job->job, 1)) return win_error(env, "terminate", GetLastError());
  napi_value result;
  if (JS(napi_get_undefined)(env, &result) != napi_ok) return NULL;
  return result;
}

static napi_value close_job(napi_env env, napi_callback_info info) {
  WebJob *job = read_job(env, info);
  if (!job) return NULL;
  DWORD active = 0;
  if (!job_state(job, &active)) return win_error(env, "query", GetLastError());
  if (active || !job->exited) return win_error(env, "close_active", ERROR_BUSY);
  release_handles(job);
  napi_value result;
  if (JS(napi_get_undefined)(env, &result) != napi_ok) return NULL;
  return result;
}

NAPI_MODULE_EXPORT int32_t NODE_API_MODULE_GET_API_VERSION(void) { return 8; }
NAPI_MODULE_EXPORT napi_value NAPI_MODULE_INITIALIZER(napi_env env, napi_value exports) {
  InitOnceExecuteOnce(&api_once, load_api, NULL, NULL);
  if (missing_api) {
    if (JS(napi_throw_error)) JS(napi_throw_error)(env, "web_job_node_api", missing_api);
    return NULL;
  }
  const char *names[] = { "launch", "poll", "terminate", "close" };
  napi_callback functions[] = { launch, poll_job, terminate_job, close_job };
  for (size_t i = 0; i < 4; i++) {
    napi_value function;
    if (JS(napi_create_function)(env, names[i], NAPI_AUTO_LENGTH, functions[i], NULL, &function) != napi_ok ||
        JS(napi_set_named_property)(env, exports, names[i], function) != napi_ok) return NULL;
  }
  return exports;
}
