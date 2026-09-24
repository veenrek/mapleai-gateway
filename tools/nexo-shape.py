import json
d = json.load(open('/tmp/nexo-models.json'))
print('--- first entry ---')
print(json.dumps(d['data'][0], indent=1, ensure_ascii=False))
print('--- union of keys ---')
print(sorted({k for m in d['data'] for k in m}))
print('--- top-level keys ---')
print(sorted(d.keys()))
for k, v in d.items():
    if k != 'data':
        print(k, '=', json.dumps(v, ensure_ascii=False)[:400])
