"""Hit, scadenza e copie indipendenti senza attendere il tempo reale."""

from concurrent.futures import ThreadPoolExecutor

import pytest

from result_cache import ResultCache


def test_hit_scadenza_lru_e_copie():
    now = [0.0]
    cache = ResultCache(maxsize=2, ttl=10, clock=lambda: now[0])
    first = cache.get_or_create("a", lambda: {"rows": [1]})
    first["rows"].append(99)
    assert cache.get_or_create("a", lambda: {"rows": [2]}) == {"rows": [1]}
    cache.get_or_create("b", lambda: 2)
    cache.get_or_create("a", lambda: 0)
    cache.get_or_create("c", lambda: 3)
    assert cache.get_or_create("b", lambda: 20) == 20
    now[0] = 10
    assert cache.get_or_create("b", lambda: 21) == 21
    cache.clear()
    assert cache.get_or_create("b", lambda: 22) == 22


def test_errori_non_memorizzati():
    cache = ResultCache()

    def fail():
        raise ValueError("Errore controllato")

    with pytest.raises(ValueError):
        cache.get_or_create("a", fail)
    assert cache.get_or_create("a", lambda: 42) == 42


def test_concorrenza_calcola_una_volta_e_separa_le_copie():
    cache = ResultCache()
    calls = []

    def create():
        calls.append(1)
        return {"rows": [42]}

    with ThreadPoolExecutor(max_workers=4) as pool:
        values = list(pool.map(lambda _: cache.get_or_create("same", create), range(8)))
    assert calls == [1]
    values[0]["rows"].append(99)
    assert values[1:] == [{"rows": [42]}] * 7
