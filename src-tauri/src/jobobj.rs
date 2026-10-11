//! Windows Job Object：把 sidecar 放進「Job 關閉即殺掉全部行程」的工作
//! 物件，確保 App 異常退出時 Python / ffmpeg 子進程一起被回收。

#[cfg(windows)]
pub fn assign_kill_on_close(child: &std::process::Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    unsafe {
        let job: HANDLE = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() || job == INVALID_HANDLE_VALUE as HANDLE {
            return;
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            return;
        }

        // 刻意不 CloseHandle(job)：Job 生命週期綁定本行程，行程結束代碼
        // 觸發 KILL_ON_JOB_CLOSE，作業系統負責回收整棵進程樹。
        let _ = AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE);
    }
}

#[cfg(not(windows))]
pub fn assign_kill_on_close(_child: &std::process::Child) {}
