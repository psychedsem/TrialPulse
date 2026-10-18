"""Cache locale limitata: nessuna persistenza, contenuto sempre copiato."""

from collections import OrderedDict
from collections.abc import Callable, Hashable
from copy import deepcopy
from threading import RLock
from time import monotonic


class ResultCache[T]:
    def __init__(
        self,
        maxsize: int = 64,
        ttl: float = 60,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        if maxsize < 1 or ttl <= 0:
            raise ValueError("Limiti della cache non validi.")
        self._maxsize = maxsize
        self._ttl = ttl
        self._clock = clock
        self._values: OrderedDict[Hashable, tuple[float, T]] = OrderedDict()
        self._lock = RLock()

    def get_or_create(self, key: Hashable, create: Callable[[], T]) -> T:
        with self._lock:
            now = self._clock()
            for expired in [k for k, (deadline, _) in self._values.items() if deadline <= now]:
                del self._values[expired]
            if key in self._values:
                self._values.move_to_end(key)
                return deepcopy(self._values[key][1])
            value = create()
            self._values[key] = (self._clock() + self._ttl, deepcopy(value))
            while len(self._values) > self._maxsize:
                self._values.popitem(last=False)
            return deepcopy(value)

    def clear(self) -> None:
        with self._lock:
            self._values.clear()
