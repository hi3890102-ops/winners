#!/usr/bin/env python3
"""Generate user/admin artifacts from the canonical index.html.

This command does not deploy or modify either repository. Write output outside
the web publish directory: the admin artifact must never ship with the user app.
"""
from pathlib import Path
import argparse
import json

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1] / 'index.html')
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
source = args.source.resolve()
output = args.output.resolve()
repository = Path(__file__).resolve().parents[1]
if output == repository or repository in output.parents:
    parser.error('Choose an output directory outside the user-app publish directory.')
user = source.read_text(encoding='utf-8')
config = json.loads(Path(__file__).with_name('admin-variant.json').read_text(encoding='utf-8'))
admin = user
for change in config['changes']:
    if admin.count(change['source']) != 1:
        raise SystemExit('A build-specific source anchor changed. Review the variants before generating.')
    admin = admin.replace(change['source'], change['admin'], 1)
output.mkdir(parents=True, exist_ok=True)
(output / 'manee-app.html').write_text(user, encoding='utf-8')
(output / 'manee-admin.html').write_text(admin, encoding='utf-8')
print(json.dumps({'user':str(output/'manee-app.html'), 'admin':str(output/'manee-admin.html'), 'deployed':False},ensure_ascii=False))
