"""Explicit one-command download + verified preparation. The serving process never imports this."""
import argparse
import hashlib
import json
import os
import tempfile
import urllib.request
from pathlib import Path
from prepare_models import prepare
from worker import validate_models, MODELS


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def download(spec, cache):
    if not spec['url'].startswith('https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/'):
        raise ValueError('Download source is outside the pinned official model directory')
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / (spec['name'] + '_infer.tar')
    if target.is_file() and target.stat().st_size == spec['bytes'] and sha256_file(target) == spec['sha256']:
        return target
    partial = cache / (spec['name'] + '.part-' + str(os.getpid()))
    digest = hashlib.sha256()
    total = 0
    try:
        with urllib.request.urlopen(spec['url'], timeout=120) as response, partial.open('wb') as output:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > spec['bytes']:
                    raise ValueError('Official archive exceeds the pinned byte length')
                output.write(chunk)
                digest.update(chunk)
            output.flush()
            os.fsync(output.fileno())
        if total != spec['bytes'] or digest.hexdigest() != spec['sha256']:
            raise ValueError('Official archive hash/length changed; do not prepare it')
        partial.replace(target)
        return target
    finally:
        partial.unlink(missing_ok=True)


def download_and_prepare(output, cache):
    output, cache = Path(output), Path(cache)
    valid, _ = validate_models(output)
    if valid:
        return {'prepared': True, 'already_present': True, 'models': MODELS}
    if output.exists() and any(output.iterdir()):
        raise ValueError('Existing model volume is not valid; use a new output directory')
    pinned = json.loads(Path(__file__).with_name('model-sources.json').read_text())
    if pinned['ocr_version'] != 'PP-OCRv5':
        raise ValueError('Incorrect pinned model version')
    archives = {}
    for role, name in MODELS.items():
        spec = pinned['models'][role]
        if spec['name'] != name:
            raise ValueError('Incorrect pinned model name')
        archives[role] = (download(spec, cache), spec['sha256'])
    manifest = prepare(archives, output)
    manifest['provenance'] = {'source_document': pinned['source_document'], 'hash_provenance': pinned['hash_provenance']}
    for role, spec in pinned['models'].items():
        manifest['sources'][role].update({'url': spec['url'], 'archive_bytes': spec['bytes'], 'model': spec['name']})
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return {'prepared': True, 'models': manifest['models'], 'files': len(manifest['files']), 'source_document': pinned['source_document']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--cache', default=str(Path(tempfile.gettempdir()) / 'image2-ocr-model-downloads'))
    arguments = parser.parse_args()
    print(json.dumps(download_and_prepare(arguments.output, arguments.cache), indent=2))
