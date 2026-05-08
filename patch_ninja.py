"""Patch ninja.exe to add longPathAware manifest so it works with Windows long paths."""
import ctypes
import ctypes.wintypes
import shutil
import sys
import os

NINJA_PATH = r"C:\Users\parth\AppData\Local\Android\Sdk\cmake\3.22.1\bin\ninja.exe"
BACKUP_PATH = NINJA_PATH + ".bak"

MANIFEST_XML = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
    </windowsSettings>
  </application>
</assembly>
"""

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

kernel32.BeginUpdateResourceW.restype = ctypes.wintypes.HANDLE
kernel32.BeginUpdateResourceW.argtypes = [ctypes.wintypes.LPCWSTR, ctypes.wintypes.BOOL]

kernel32.UpdateResourceW.restype = ctypes.wintypes.BOOL
kernel32.UpdateResourceW.argtypes = [
    ctypes.wintypes.HANDLE,
    ctypes.c_void_p,   # lpType  (MAKEINTRESOURCE)
    ctypes.c_void_p,   # lpName  (MAKEINTRESOURCE)
    ctypes.wintypes.WORD,
    ctypes.c_void_p,
    ctypes.wintypes.DWORD,
]

kernel32.EndUpdateResourceW.restype = ctypes.wintypes.BOOL
kernel32.EndUpdateResourceW.argtypes = [ctypes.wintypes.HANDLE, ctypes.wintypes.BOOL]

RT_MANIFEST = 24
CREATEPROCESS_MANIFEST_RESOURCE_ID = 1

def patch_ninja():
    if not os.path.exists(BACKUP_PATH):
        shutil.copy2(NINJA_PATH, BACKUP_PATH)
        print(f"Backed up to {BACKUP_PATH}")
    else:
        print("Backup already exists — overwriting ninja.exe with fresh patch")

    h = kernel32.BeginUpdateResourceW(NINJA_PATH, False)
    if not h:
        print(f"BeginUpdateResourceW failed: {ctypes.get_last_error()}")
        sys.exit(1)

    data = ctypes.create_string_buffer(MANIFEST_XML)
    ok = kernel32.UpdateResourceW(
        h,
        RT_MANIFEST,      # ctypes auto-casts int -> void*
        CREATEPROCESS_MANIFEST_RESOURCE_ID,
        0,                # MAKELANGID(LANG_NEUTRAL, SUBLANG_NEUTRAL)
        data,
        len(MANIFEST_XML),
    )
    if not ok:
        err = ctypes.get_last_error()
        kernel32.EndUpdateResourceW(h, True)
        print(f"UpdateResourceW failed: error {err}")
        sys.exit(1)

    ok = kernel32.EndUpdateResourceW(h, False)
    if not ok:
        print(f"EndUpdateResourceW failed: {ctypes.get_last_error()}")
        sys.exit(1)

    print("Successfully patched ninja.exe with longPathAware manifest.")

if __name__ == "__main__":
    patch_ninja()
