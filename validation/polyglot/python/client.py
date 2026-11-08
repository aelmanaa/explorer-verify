"""Python standard-library consumer: JSON parsing and assertions happen here."""
import json
import pathlib
import subprocess
import sys

config = json.loads(pathlib.Path(sys.argv[1]).read_text())
results = []
handle = None
for case in config['cases']:
    args = [handle if arg == '$HANDLE' else arg for arg in case['args']]
    completed = subprocess.run(config['command'] + args, input='', text=True,
                               capture_output=True, timeout=15,
                               env=dict(config['environment'], POLYGLOT_SCENARIO=case['scenario'],
                                        POLYGLOT_LOG=case['log']))
    envelope = json.loads(completed.stdout)
    assert envelope['schemaVersion'] == 1
    assert completed.returncode == case['exitCode'], completed.stderr
    assert envelope['ok'] == (completed.returncode == 0)
    value = envelope.get('result', envelope.get('error'))
    assert value.get('status', value.get('code')) == case['expected'], envelope
    if case['expected'] == 'verified':
        assert value['backend'] == 'sourcify' and value['match'] == 'exact'
    if case['expected'] == 'failed':
        assert 'no_match' in value['reason'] and 'error' not in envelope
    if case['expected'] == 'not-confirmed':
        assert value['retryable'] is True
        handle = value['handle']
        assert handle.startswith('ev1:sourcify:11155111:')
        assert envelope['nextCommand'] == ['explorer-verify', 'status', handle, '--json']
    if case['expected'] in ('invalid-input', 'incomplete-input'):
        assert value['retryable'] is False and value['hint'] and value['details']['code'] == case['expected']
    results.append(dict(name=case['name'], success=True, exitCode=completed.returncode,
                        envelope=envelope, stderr=completed.stderr))
print(json.dumps(dict(language='python', success=True, scenarios=results)))
