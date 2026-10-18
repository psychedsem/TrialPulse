"""Il launcher non interrompe servizi estranei e ripulisce soltanto i propri handle."""

import socket
import unittest
from unittest.mock import Mock, patch

from scripts import dev


class LauncherTests(unittest.TestCase):
    def test_occupied_port_refuses_start_before_process_creation(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            with self.assertRaisesRegex(RuntimeError, "occupata"):
                dev.assert_ports_free([listener.getsockname()[1]])
        with patch.object(dev, "assert_ports_free", side_effect=RuntimeError("occupata")):
            with patch.object(dev.subprocess, "Popen") as spawn:
                with self.assertRaises(RuntimeError):
                    dev.start()
                spawn.assert_not_called()

    def test_cleanup_uses_only_live_owned_process_handles(self):
        running = Mock()
        running.poll.return_value = None
        exited = Mock()
        exited.poll.return_value = 0
        dev.stop_children([running, exited])
        running.terminate.assert_called_once_with()
        exited.terminate.assert_not_called()
        running.kill.assert_not_called()

    def test_cleanup_escalates_only_unresponsive_owned_handle(self):
        running = Mock()
        running.poll.return_value = None
        running.wait.side_effect = [dev.subprocess.TimeoutExpired("child", 10), 0]
        dev.stop_children([running])
        running.kill.assert_called_once_with()

    def test_stop_does_not_search_or_signal_other_processes(self):
        with patch.object(dev.sys, "argv", ["dev.py", "stop"]):
            with patch.object(dev.subprocess, "Popen") as spawn:
                self.assertEqual(dev.main(), 0)
                spawn.assert_not_called()

    def test_partial_start_failure_stops_only_started_process(self):
        child = Mock()
        child.poll.return_value = None
        with patch.object(dev, "assert_ports_free"):
            with patch.object(dev.Path, "exists", return_value=True):
                with patch.object(dev, "executable", return_value="node"):
                    with patch.object(
                        dev.subprocess, "Popen", side_effect=[child, OSError("avvio fallito")]
                    ):
                        with self.assertRaises(OSError):
                            dev.start()
        child.terminate.assert_called_once_with()

    def test_supervised_start_disables_dynamic_analysis_and_cleans_on_interrupt(self):
        children = [Mock() for _ in range(4)]
        for child in children:
            child.poll.return_value = None
        with (
            patch.object(dev, "assert_ports_free"),
            patch.dict(dev.os.environ, {"GROQ_API_KEY": "fixture_locale"}),
        ):
            with patch.object(dev.Path, "exists", return_value=True):
                with patch.object(dev, "executable", return_value="node"):
                    with patch.object(dev.subprocess, "Popen", side_effect=children) as spawn:
                        with patch.object(dev.time, "sleep", side_effect=KeyboardInterrupt):
                            dev.start()
        self.assertEqual(spawn.call_count, 4)
        for call in spawn.call_args_list:
            self.assertEqual(call.kwargs["env"]["TRIALPULSE_PANDAS_ENABLED"], "0")
            self.assertEqual(call.kwargs["env"]["PYTHON_BRIDGE_ENABLED"], "false")
            self.assertNotIn("shell", call.kwargs)
        for index in (0, 1, 3):
            self.assertNotIn("GROQ_API_KEY", spawn.call_args_list[index].kwargs["env"])
        self.assertEqual(spawn.call_args_list[2].kwargs["env"]["GROQ_API_KEY"], "fixture_locale")
        for child in children:
            child.terminate.assert_called_once_with()
