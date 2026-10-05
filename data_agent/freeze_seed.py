# Congelamento del MASTER_SEED

from pathlib import Path
import secrets
import yaml
output = Path(__file__).parent / 'config' / 'reproducibility.yaml'
data = {'master_seed': secrets.randbits(63), 'generation_method': 'secrets.randbits(63)', 'status': 'frozen'}
with open(output, 'x', encoding='utf-8') as file:
    yaml.safe_dump(data, file, sort_keys=False)
print('MASTER_SEED generato e congelato.')