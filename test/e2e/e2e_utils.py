import contextlib
import logging
import os
import shlex
import socket
import subprocess
import sys
import time
import typing
from contextlib import closing
from tempfile import TemporaryFile

import requests


LOGGER = logging.getLogger(__file__)


def _find_free_port():
    """Find and return a free port on the local machine."""
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("", 0))  # 0 means that the OS chooses a random port
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return int(s.getsockname()[1])  # [1] contains the randomly selected port number


class AsyncSubprocess:
    """A context manager. Wraps subprocess. Popen to capture output safely."""

    def __init__(
        self,
        args: typing.List[str],
        cwd: typing.Optional[str] = None,
        env: typing.Optional[typing.Dict[str, str]] = None,
    ):
        """Initialize an AsyncSubprocess instance.

        Args:
            args (List[str]): List of command-line arguments.
            cwd (str, optional): Current working directory. Defaults to None.
            env (dict, optional): Environment variables. Defaults to None.
        """
        self.args = args
        self.cwd = cwd
        self.env = env
        self._proc = None
        self._stdout_file = None
        self._captured_output = ""

    def captured_output(self) -> str:
        """Return captured output after the subprocess has exited."""
        if self._stdout_file is None:
            return self._captured_output

        self._stdout_file.flush()
        position = self._stdout_file.tell()
        self._stdout_file.seek(0)
        output = self._stdout_file.read()
        self._stdout_file.seek(position)
        return output

    def poll(self) -> typing.Optional[int]:
        """Return the subprocess exit code, or ``None`` while it is running."""
        if self._proc is None:
            return None
        return self._proc.poll()

    def terminate(self, timeout: float = 5) -> str:
        """Terminate and reap the process, returning its stdout/stderr."""
        process = self._proc
        if process is not None:
            if process.poll() is None:
                with contextlib.suppress(ProcessLookupError):
                    process.terminate()
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                LOGGER.warning(
                    "Process did not terminate after %.1fs; killing it: %s",
                    timeout,
                    shlex.join(self.args),
                )
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
                process.wait()
            self._proc = None

        self._captured_output = self.captured_output()
        if self._stdout_file is not None:
            self._stdout_file.close()
            self._stdout_file = None
        return self._captured_output

    def __enter__(self) -> "AsyncSubprocess":
        """Start the subprocess when entering the context."""
        self.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Stop the subprocess and close resources when exiting the context."""
        self.stop()

    def start(self):
        # Start the process and capture its stdout/stderr output to a temp
        # file. We do this instead of using subprocess.PIPE (which causes the
        # Popen object to capture the output to its own internal buffer),
        # because large amounts of output can cause it to deadlock.
        self._captured_output = ""
        self._stdout_file = TemporaryFile("w+")
        LOGGER.info("Running command: %s", shlex.join(self.args))
        self._proc = subprocess.Popen(
            self.args,
            cwd=self.cwd,
            stdout=self._stdout_file,
            stderr=subprocess.STDOUT,
            text=True,
            env={**os.environ.copy(), **self.env} if self.env else None,
        )

    def stop(self) -> str:
        """Terminate and reap the subprocess, then close its resources."""
        return self.terminate()


class StreamlitRunner:
    """A context manager for running Streamlit scripts."""

    def __init__(
        self,
        script_path: os.PathLike,
        server_port: typing.Optional[int] = None,
        extra_args: typing.Optional[typing.Sequence[str]] = None,
    ):
        """Initialize a StreamlitRunner instance.

        Args:
            script_path (os.PathLike): Path to the Streamlit script to run.
            server_port (int, optional): Port for the Streamlit server. Defaults to None.
            extra_args (Sequence[str], optional): Additional ``streamlit run``
                command-line options. Defaults to None.
        """
        self._process = None
        self.server_port = server_port
        self.script_path = script_path
        self.extra_args = list(extra_args or ())

    def __enter__(self) -> "StreamlitRunner":
        """Start the Streamlit server when entering the context."""
        self.start()
        return self

    def __exit__(self, type, value, traceback):
        """Stop the Streamlit server and close resources when exiting the context."""
        self.stop()

    def start(self):
        """Start the Streamlit server using the specified script and options."""
        self.server_port = self.server_port or _find_free_port()
        self._process = AsyncSubprocess(
            [
                sys.executable,
                "-m",
                "streamlit",
                "run",
                str(self.script_path),
                f"--server.port={self.server_port}",
                "--server.address=127.0.0.1",
                "--server.headless=true",
                "--browser.gatherUsageStats=false",
                "--global.developmentMode=false",
                *self.extra_args,
            ]
        )
        self._process.start()
        if not self.is_server_running():
            output = self._process.stop()
            self._process = None
            raise RuntimeError(
                "Application failed to start. Captured output:\n" + output
            )

    def stop(self) -> str:
        """Stop the Streamlit server and close resources."""
        if self._process is None:
            return ""
        return_code = self._process.poll()
        output = self._process.stop()
        self._process = None
        if return_code is not None:
            LOGGER.error(
                "Streamlit server exited unexpectedly with code %s. "
                "Captured output:\n%s",
                return_code,
                output,
            )
        return output

    def assert_running(self):
        """Raise with captured diagnostics if the Streamlit server exited."""
        if self._process is None:
            raise RuntimeError("Streamlit server is not running")

        return_code = self._process.poll()
        if return_code is not None:
            output = self._process.captured_output()
            raise RuntimeError(
                f"Streamlit server exited with code {return_code}. "
                f"Captured output:\n{output}"
            )

    def is_server_running(self, timeout: int = 30) -> bool:
        """Check if the Streamlit server is running.

        Args:
            timeout (int, optional): Maximum time to wait for the server to start. Defaults to 30.

        Returns:
            bool: True if the server is running, False otherwise.
        """
        deadline = time.monotonic() + timeout
        with requests.Session() as http_session:
            while time.monotonic() < deadline:
                if self._process is None or self._process.poll() is not None:
                    return False
                with contextlib.suppress(requests.RequestException):
                    response = http_session.get(
                        self.server_url + "/_stcore/health", timeout=1
                    )
                    if response.ok and response.text == "ok":
                        return True
                time.sleep(0.2)
        return False

    @property
    def server_url(self) -> str:
        """Get the URL of the Streamlit server."""
        if not self.server_port:
            raise RuntimeError("Unknown server port")
        return f"http://127.0.0.1:{self.server_port}"
