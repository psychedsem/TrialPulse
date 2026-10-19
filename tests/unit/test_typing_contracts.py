"""Contratti statici dei parametri e validazione runtime senza servizi esterni."""

from importlib.util import find_spec
from pathlib import Path
from types import MappingProxyType
import subprocess
import sys

import pytest

from models import validate_parameters

ROOT = Path(__file__).resolve().parents[2]
MYPY_AVAILABLE = find_spec("mypy") is not None


def check_types(source, tmp_path):
    snippet = tmp_path / "contract.py"
    snippet.write_text(source, encoding="utf-8")
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "mypy",
            "--config-file",
            "pyproject.toml",
            "--no-incremental",
            "--cache-dir",
            str(tmp_path / "mypy"),
            str(snippet),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=45,
    )


@pytest.mark.skipif(not MYPY_AVAILABLE, reason="mypy richiede le dipendenze di sviluppo")
def test_richiesta_e_parametri_mantengono_tipi_espliciti(tmp_path):
    result = check_types(
        "from typing import assert_type\n"
        "from models import AnalyzeRequest, AnalysisFilters, AnalysisType, validate_parameters\n"
        "request = AnalyzeRequest(analysis=AnalysisType.recruitment)\n"
        "assert_type(request.filters, AnalysisFilters)\n"
        "assert_type(validate_parameters('recruitment', {}), dict[str, object])\n",
        tmp_path,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(not MYPY_AVAILABLE, reason="mypy richiede le dipendenze di sviluppo")
def test_argomenti_e_risultati_incompatibili_sono_rifiutati(tmp_path):
    result = check_types(
        "from models import validate_parameters\n"
        "validate_parameters(42, {})\n"
        "validate_parameters('recruitment', [])\n"
        "values: dict[str, int] = validate_parameters('recruitment', {})\n",
        tmp_path,
    )
    assert result.returncode == 1, result.stdout + result.stderr
    assert result.stdout.count("[arg-type]") == 2, result.stdout
    assert "[assignment]" in result.stdout, result.stdout


def test_parametri_dizionario_preservano_valori_e_validazioni():
    parameters = {"threshold_percent": 75, "consecutive_months": 2}
    assert validate_parameters("recruitment_target", parameters) == {
        "threshold_percent": 75.0,
        "consecutive_months": 2,
    }
    with pytest.raises(ValueError, match="fuori dominio"):
        validate_parameters(
            "recruitment_target", {"threshold_percent": "75", "consecutive_months": 2}
        )
    with pytest.raises(ValueError, match="fuori dominio"):
        validate_parameters("recruitment_target", MappingProxyType(parameters))
