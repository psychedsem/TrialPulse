"""Il launcher non interrompe servizi estranei e ripulisce soltanto i propri handle."""

import socket
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

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
        with (
            patch.object(dev, "assert_ports_free"),
            patch.object(dev.Path, "exists", return_value=True),
            patch.object(dev, "executable", return_value="node"),
            patch.object(dev.subprocess, "Popen", side_effect=[child, OSError("avvio fallito")]),
            self.assertRaises(OSError),
        ):
            dev.start()
        child.terminate.assert_called_once_with()

    def test_supervised_start_disables_dynamic_analysis_and_cleans_on_interrupt(self):
        children = [Mock() for _ in range(4)]
        for child in children:
            child.poll.return_value = None
        with (
            patch.object(dev, "assert_ports_free"),
            patch.dict(dev.os.environ, {"GROQ_API_KEY": "fixture_locale"}),
            patch.object(dev.Path, "exists", return_value=True),
            patch.object(dev, "executable", return_value="node"),
            patch.object(dev.subprocess, "Popen", side_effect=children) as spawn,
            patch.object(dev.time, "sleep", side_effect=KeyboardInterrupt),
        ):
            dev.start()
        self.assertEqual(spawn.call_count, 4)
        self.assertEqual(
            [call.kwargs["cwd"] for call in spawn.call_args_list],
            [dev.ROOT / name for name in ("data_agent", "rag", "backend", "frontend")],
        )
        for index, port in ((0, "8000"), (1, "8001")):
            self.assertEqual(
                spawn.call_args_list[index].args[0][1:],
                ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", port],
            )
        self.assertEqual(spawn.call_args_list[2].args[0], ["node", "src/server.js"])
        self.assertEqual(
            spawn.call_args_list[3].args[0],
            [
                "node",
                "node_modules/vite/bin/vite.js",
                "--host",
                "127.0.0.1",
                "--port",
                "5173",
                "--strictPort",
            ],
        )
        for call in spawn.call_args_list:
            self.assertEqual(call.kwargs["env"]["TRIALPULSE_PANDAS_ENABLED"], "0")
            self.assertEqual(call.kwargs["env"]["PYTHON_BRIDGE_ENABLED"], "false")
            self.assertNotIn("shell", call.kwargs)
        for index in (0, 1, 3):
            self.assertNotIn("GROQ_API_KEY", spawn.call_args_list[index].kwargs["env"])
        self.assertEqual(spawn.call_args_list[2].kwargs["env"]["GROQ_API_KEY"], "fixture_locale")
        for child in children:
            child.terminate.assert_called_once_with()


@pytest.mark.parametrize("system,suffix", [("nt", "Scripts/python.exe"), ("posix", "bin/python")])
def test_interprete_venv_windows_e_posix_con_spazi(system, suffix):
    """Un percorso con spazi non deve essere spezzato o dipendere dalla shell."""
    root = Path("installazione con spazi")
    with patch.object(dev, "ROOT", root), patch.object(dev, "os", SimpleNamespace(name=system)):
        assert dev.python_path() == root / ".venv" / suffix


def test_comando_e_cwd_con_spazi_restano_argomenti_separati():
    root = Path("installazione con spazi")
    interpreter = root / ".venv" / "bin" / "python"
    with patch.object(dev.subprocess, "run") as execute:
        dev.run([interpreter, "-m", "pytest", root / "tests"], cwd=root)
    execute.assert_called_once_with(
        [str(interpreter), "-m", "pytest", str(root / "tests")], cwd=root, check=True
    )


@pytest.mark.parametrize("full", [False, True])
@pytest.mark.parametrize("already_exists", [False, True])
def test_setup_seleziona_profili_e_non_ricrea_venv_esistente(full, already_exists):
    """Sono intercettate installazioni esterne, non la scelta del profilo del launcher."""
    root = Path("installazione con spazi")
    interpreter = root / ".venv" / "bin" / "python"
    commands = []
    with (
        patch.object(dev, "ROOT", root),
        patch.object(dev, "python_path", return_value=interpreter),
        patch.object(dev.Path, "exists", return_value=already_exists),
        patch.object(dev.venv, "create") as create,
        patch.object(dev, "executable", return_value="npm"),
        patch.object(dev, "run", side_effect=lambda args, cwd=None: commands.append((args, cwd))),
    ):
        dev.setup(full)
    if already_exists:
        create.assert_not_called()
    else:
        create.assert_called_once_with(root / ".venv", with_pip=True)
    requirements = (
        ["requirements-dev.txt", "rag/requirements.txt"] if full else ["requirements-dev.txt"]
    )
    assert commands == [
        *[([interpreter, "-m", "pip", "install", "-r", name], None) for name in requirements],
        (["npm", "ci"], root / "backend"),
        (["npm", "ci"], root / "frontend"),
    ]


def test_eseguibile_assente_produce_errore_prima_di_lanciare_comandi():
    with patch.object(dev.shutil, "which", return_value=None):
        with pytest.raises(RuntimeError, match="non trovato: npm"):
            dev.executable("npm")


@pytest.mark.skipif(dev.shutil.which("npm") is None, reason="npm non disponibile nel PATH")
def test_npm_installato_e_avviabile_senza_shell():
    """Prova reale del comando risolto, senza installazioni o accesso al provider."""
    dev.run([dev.executable("npm"), "--version"])


def test_errore_installazione_si_propaga_senza_proseguire():
    with (
        patch.object(dev.Path, "exists", return_value=True),
        patch.object(dev, "run", side_effect=dev.subprocess.CalledProcessError(1, "pip")) as run,
        patch.object(dev, "executable") as find_npm,
    ):
        with pytest.raises(dev.subprocess.CalledProcessError):
            dev.setup(full=True)
    assert run.call_count == 1
    find_npm.assert_not_called()
