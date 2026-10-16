# 최소 사양

> 아래 값은 **추정**이에요. 기준 설치에서 아직 측정하지 않았어요.

## 서버

| | 최소(추정) | 참고 |
|---|---|---|
| CPU | 2 vCPU | 동시 실행 하나가 Chromium이 그리는 동안 코어 하나쯤 써요. |
| 메모리 | 4 GB | 동시 실행당 약 0.5~1 GB, 여기에 Postgres와 web 서버가 더해져요. `WORKER_CONCURRENCY`를 올리면 늘려 주세요. |
| 디스크 | 여유 20 GB | 스크린샷·영상은 쓸수록 늘어요. 여유 공간이 `MIN_FREE_DISK_MB`(기본 1024 MB)보다 적으면 worker가 실행을 받지 않아요. |
| OS | Linux, amd64·arm64 | Docker Engine과 Compose v2.3 이상. worker는 Chromium 샌드박스에 user namespace가 필요해요([troubleshooting.md](troubleshooting.md) 참고). |
| Postgres | 18(함께 뜸) | `DATABASE_URL`로 외부 Postgres도 쓸 수 있어요. |

1.0 지원 범위: Chromium만, worker 인스턴스 하나. worker를 여러 개 띄울 수는 있지만 1.0 시험 범위에는 들어가지 않아요.

## 데스크톱 앱

| | 최소(추정) |
|---|---|
| macOS | Apple Silicon 또는 Intel, 지원 중인 macOS 릴리스 |
| Windows | Windows 10·11, x64 |
| 메모리 | 8 GB |
| 디스크 | 앱과 동봉 Chromium에 1 GB |

## AI(선택)

데스크톱 앱과 같은 PC에 Claude Code 2.1.300 이상 또는 Codex CLI 0.162.1 이상. [ai.md](ai.md)를 보세요.
