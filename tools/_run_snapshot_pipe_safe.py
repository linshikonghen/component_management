import subprocess
import tempfile
import sys
import runpy

_real = subprocess.run


def run(*a, **k):
    """编排包装：本机沙箱下 subprocess 的管道 stdio 会被拒（WinError 5），
    遇到就退化到临时文件收集输出，接口与 capture_output 兼容。"""
    try:
        return _real(*a, **k)
    except PermissionError:
        out = tempfile.TemporaryFile()
        err = tempfile.TemporaryFile()
        k2 = dict(k)
        k2.pop("capture_output", False)
        text = k2.pop("text", False) or k2.pop("universal_newlines", False)
        k2.pop("stdout", None)
        k2.pop("stderr", None)
        k2["stdout"] = out
        k2["stderr"] = err
        r = _real(*a, **k2)
        out.seek(0)
        err.seek(0)
        o = out.read()
        e = err.read()
        if text:
            o = o.decode("utf-8", "replace")
            e = e.decode("utf-8", "replace")
        return subprocess.CompletedProcess(a[0] if a else None, r.returncode, o, e)


subprocess.run = run
sys.argv = ["tools/make_public_snapshot.py"]
runpy.run_path("tools/make_public_snapshot.py", run_name="__main__")
