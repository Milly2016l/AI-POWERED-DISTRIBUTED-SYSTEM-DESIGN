"""
tests/test_worker.py
=====================
Unit tests for the Celery worker task (BiustSystem/workers/worker.py).

Tests call process_metric directly (not via Celery broker)
so no Redis connection is required.

Run from project root:
    pytest tests/ -v
"""

import sys
import os
import pytest

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from BiustSystem.workers.worker import process_metric


def _run(data: dict) -> dict:
    """
    Call process_metric directly bypassing the Celery broker.

    Args:
        data: metric dict to process.

    Returns:
        The task result dict.
    """
    return process_metric(data)


def test_process_metric_normal():
    """
    process_metric with normal CPU and memory should return
    status 'processed' and correct server field.
    """
    result = _run({
        "server_id":    "test-node",
        "cpu_usage":    50,
        "memory_usage": 50,
        "requests":     500,
        "latency":      100,
    })
    assert result["status"] == "processed"
    assert result["server"] == "test-node"


def test_process_metric_high_cpu():
    """
    process_metric with CPU=90 should return a dict
    containing cpu=90 and status 'processed'.
    """
    result = _run({
        "server_id":    "high-cpu-node",
        "cpu_usage":    90,
        "memory_usage": 45,
        "requests":     300,
        "latency":      80,
    })
    assert result["cpu"] == 90
    assert result["status"] == "processed"


def test_process_metric_high_memory():
    """
    process_metric with memory=85 should return
    status 'processed' and correct memory value.
    """
    result = _run({
        "server_id":    "high-mem-node",
        "cpu_usage":    40,
        "memory_usage": 85,
        "requests":     200,
        "latency":      60,
    })
    assert result["memory"] == 85
    assert result["status"] == "processed"


def test_process_metric_missing_fields():
    """
    process_metric with missing fields should use
    defaults (0 / 'unknown') and still return 'processed'.
    """
    result = _run({})
    assert result["status"] == "processed"
    assert result["server"] == "unknown"
    assert result["cpu"] == 0