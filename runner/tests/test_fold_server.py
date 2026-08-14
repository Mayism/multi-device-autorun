import importlib.util
import pathlib
import sys
import unittest
from types import SimpleNamespace
from unittest import mock


SCRIPT = (
    pathlib.Path(__file__).resolve().parents[1]
    / "src"
    / "fold"
    / "assets"
    / "fold-server.py"
)
SPEC = importlib.util.spec_from_file_location("fold_server", SCRIPT)
fold_server = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(fold_server)


class FoldServerCommandTests(unittest.TestCase):
    def setUp(self):
        self.original_hdc = fold_server.HDC
        self.original_emulator = fold_server.EMULATOR
        self.original_port = fold_server.PORT
        self.original_device_port = fold_server.DEVICE_PORT

    def tearDown(self):
        fold_server.HDC = self.original_hdc
        fold_server.EMULATOR = self.original_emulator
        fold_server.PORT = self.original_port
        fold_server.DEVICE_PORT = self.original_device_port

    def test_windows_style_paths_keep_target_in_every_hdc_command(self):
        fold_server.HDC = r"D:\DevEco Studio\hdc.exe"
        fold_server.PORT = 8766
        fold_server.DEVICE_PORT = 8765
        commands = []

        def run(command, timeout):
            commands.append(command)
            return SimpleNamespace(returncode=0, stdout="OK", stderr="")

        with mock.patch.object(fold_server, "run_command", side_effect=run):
            self.assertTrue(fold_server.setup_fport("127.0.0.1:15003"))

        self.assertGreaterEqual(len(commands), 5)
        for command in commands:
            self.assertEqual(command[0], fold_server.HDC)
            self.assertEqual(command[1:3], ["-t", "127.0.0.1:15003"])

    def test_emulator_command_uses_an_argument_array(self):
        fold_server.EMULATOR = r"D:\DevEco Studio\Emulator.exe"
        captured = []

        def run(command, timeout):
            captured.append(command)
            return SimpleNamespace(returncode=0, stdout="success", stderr="")

        with mock.patch.object(fold_server, "run_command", side_effect=run):
            success, _ = fold_server.do_fold("half-open")

        self.assertTrue(success)
        self.assertEqual(
            captured,
            [[fold_server.EMULATOR, "-instance", fold_server.EMULATOR_INSTANCE, "-foldedState", "half-open"]],
        )


class FoldServerModeTests(unittest.TestCase):
    def run_main(self, forwarding, owner_token="", setup_result=True, server_error=None):
        server = mock.Mock()
        server.serve_forever.side_effect = server_error or KeyboardInterrupt
        argv = [
            str(SCRIPT),
            "--profile",
            "Mate X7",
            "--port",
            "8766",
            "--target",
            "127.0.0.1:15003",
            "--forwarding",
            forwarding,
        ]
        if owner_token:
            argv.extend(["--owner-token", owner_token])
        with (
            mock.patch.object(sys, "argv", argv),
            mock.patch.object(fold_server.http.server, "HTTPServer", return_value=server),
            mock.patch.object(fold_server, "setup_fport", return_value=setup_result) as setup,
            mock.patch.object(fold_server, "cleanup_fport") as cleanup,
            mock.patch.object(fold_server.signal, "signal"),
        ):
            try:
                fold_server.main()
                error = None
            except BaseException as caught:
                error = caught
        return server, setup, cleanup, error

    def test_self_mode_cleans_forwarding_in_finally(self):
        server, setup, cleanup, error = self.run_main("self")

        self.assertIsNone(error)
        setup.assert_called_once_with("127.0.0.1:15003")
        cleanup.assert_called_once_with("127.0.0.1:15003")
        server.server_close.assert_called_once_with()

    def test_external_mode_leaves_forwarding_to_the_runner(self):
        server, setup, cleanup, error = self.run_main("external", "runner-token")

        self.assertIsNone(error)
        setup.assert_not_called()
        cleanup.assert_not_called()
        server.server_close.assert_called_once_with()
        self.assertEqual(fold_server.OWNER_TOKEN, "runner-token")

    def test_self_mode_cleans_a_partial_forward_when_setup_fails(self):
        server, setup, cleanup, error = self.run_main("self", setup_result=False)

        self.assertIsInstance(error, SystemExit)
        setup.assert_called_once_with("127.0.0.1:15003")
        cleanup.assert_called_once_with("127.0.0.1:15003")
        server.server_close.assert_called_once_with()

    def test_self_mode_cleans_forwarding_after_an_unexpected_server_error(self):
        server, setup, cleanup, error = self.run_main(
            "self", server_error=RuntimeError("server failed")
        )

        self.assertIsInstance(error, RuntimeError)
        self.assertEqual(str(error), "server failed")
        setup.assert_called_once_with("127.0.0.1:15003")
        cleanup.assert_called_once_with("127.0.0.1:15003")
        server.server_close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
