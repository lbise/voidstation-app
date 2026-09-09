#!/usr/bin/env python3
"""Compare the deployed HTTP API with local Linux host readings. Never changes Docker."""

import argparse
import json
import os
import time
import urllib.request


def host_readings(root, data):
    with open('/proc/stat') as source:
        cpu = [int(value) for value in source.readline().split()[1:9]]
    with open('/proc/uptime') as source:
        uptime = float(source.read().split()[0])
    with open('/proc/meminfo') as source:
        memory = {line.split(':')[0]: int(line.split()[1]) * 1024
                  for line in source if line.startswith(('MemTotal:', 'MemAvailable:'))}
    result = {
        'cpuCounters': cpu,
        'uptime': uptime,
        'ram': {'total': memory['MemTotal'], 'available': memory['MemAvailable'],
                'used': memory['MemTotal'] - memory['MemAvailable']},
    }
    for name, path in [('rootFilesystem', root), ('dataFilesystem', data)]:
        capacity = os.statvfs(path)
        result[name] = {
            'total': capacity.f_blocks * capacity.f_frsize,
            'used': (capacity.f_blocks - capacity.f_bfree) * capacity.f_frsize,
            'available': capacity.f_bavail * capacity.f_frsize,
        }
    return result


def fetch_metrics(url):
    request = urllib.request.Request(url.rstrip('/') + '/api/metrics',
                                     headers={'Cache-Control': 'no-store'})
    # Private-host verification must not travel through a configured HTTP proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=10) as response:
        if 'no-store' not in response.headers.get('Cache-Control', ''):
            raise RuntimeError('Metrics response permits caching')
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url', help='HTTP origin on this Ubuntu Docker host')
    parser.add_argument('root', help='Root filesystem probe directory')
    parser.add_argument('data', help='Separate data filesystem probe directory')
    args = parser.parse_args()
    if os.stat(args.root).st_dev != os.stat('/').st_dev:
        parser.error('Root probe is not on the host root filesystem')
    if os.stat(args.data).st_dev == os.stat(args.root).st_dev:
        parser.error('Data probe resolves to the root filesystem')

    # Use a five-second interval to match normal Dashboard polling. Other viewers
    # can shorten the application's CPU interval; close them for this comparison.
    start = host_readings(args.root, args.data)
    fetch_metrics(args.url)
    time.sleep(5)
    before = host_readings(args.root, args.data)
    metrics = fetch_metrics(args.url)
    after = host_readings(args.root, args.data)
    failures = []

    def check(condition, message):
        if not condition:
            failures.append(message)

    for name in ['cpu', 'uptime', 'ram', 'rootFilesystem', 'dataFilesystem']:
        check(metrics.get(name, {}).get('status') == 'available', name + ' unavailable')
    if failures:
        print(json.dumps({'metrics': metrics, 'failures': failures}, indent=2))
        return 1

    check(before['uptime'] - 1 <= metrics['uptime']['value'] <= after['uptime'] + 1,
          'Uptime differs from host boot time by more than one second')
    total_delta = sum(after['cpuCounters']) - sum(start['cpuCounters'])
    idle_delta = sum(after['cpuCounters'][3:5]) - sum(start['cpuCounters'][3:5])
    host_cpu = 100 * (total_delta - idle_delta) / total_delta
    check(abs(metrics['cpu']['value'] - host_cpu) <= 5,
          'CPU differs by more than five percentage points; retry without other viewers')
    for name in ['ram', 'rootFilesystem', 'dataFilesystem']:
        # Concurrent workloads can allocate RAM and write files between samples.
        tolerance = (max(64 * 1024**2, after[name]['total'] * .01) if name == 'ram'
                     else max(16 * 1024**2, after[name]['total'] * .00001))
        check(metrics[name]['value']['total'] == after[name]['total'],
              name + ' total differs from host')
        for field in ['used', 'available']:
            lower = min(before[name][field], after[name][field]) - tolerance
            upper = max(before[name][field], after[name][field]) + tolerance
            check(lower <= metrics[name]['value'][field] <= upper,
                  name + ' ' + field + ' differs beyond sampling tolerance')
    print(json.dumps({'hostBefore': before, 'hostAfter': after, 'hostCpuPercent': host_cpu,
                      'metrics': metrics, 'failures': failures}, indent=2))
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
