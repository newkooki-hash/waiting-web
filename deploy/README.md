# 배포 가이드 (AWS Lightsail · Ubuntu 24.04)

구성: Lightsail 서버 1대 → Caddy(HTTPS 자동) → Node 앱(`:3000`, systemd) → SQLite 파일.

## 1. Lightsail 인스턴스 만들기
1. https://lightsail.aws.amazon.com → **인스턴스 생성**
2. 리전: **서울 (ap-northeast-2)**, 플랫폼: Linux, 블루프린트: **OS 전용 → Ubuntu 24.04 LTS**
3. 플랜: 메모리 1GB 이상. 이름 예) `waiting-web`
4. 생성 후 **네트워킹 → 고정 IP 생성**해서 인스턴스에 연결 (IP가 바뀌지 않게)
5. **네트워킹 → IPv4 방화벽**: `SSH(22)`, `HTTP(80)`, `HTTPS(443)`만 둔다. 3000 등은 열지 않는다. 가능하면 SSH는 내 IP로 제한한다.

## 2. 도메인 연결
`orandabowling.co.kr`의 DNS 관리 화면에서 A 레코드를 추가한다.

| 호스트 | 종류 | 값 |
|---|---|---|
| `waiting` | A | Lightsail 고정 IP |

반영 확인: `nslookup waiting.orandabowling.co.kr` 결과가 고정 IP이면 된다. 이게 되어야 HTTPS 인증서가 발급된다.

## 3. 서버 설정 (한 번만)
Lightsail 콘솔의 **SSH 접속** 버튼으로 터미널을 연다.

```bash
sudo apt-get update && sudo apt-get install -y git
sudo git clone https://github.com/newkooki-hash/waiting-web.git /opt/waiting-web
sudo DOMAIN=waiting.orandabowling.co.kr bash /opt/waiting-web/deploy/setup.sh
```

저장소가 비공개라면 `git clone`에 인증이 필요하다. 그때는 GitHub 개인 액세스 토큰(읽기 전용)을 쓰거나, 로컬에서 `scp`로 폴더를 올린 뒤 `setup.sh`를 실행한다. 토큰은 채팅·문서에 남기지 않는다.

`setup.sh`가 하는 일: Node 24·Caddy 설치, `waiting` 전용 사용자 생성, systemd 서비스 등록, Caddy 설정, 매일 04:00 DB 백업 크론 등록.

## 4. 환경변수 채우기
```bash
sudo nano /etc/waiting-web.env
```
`.env.example`을 바탕으로 만들어져 있고 운영 값(`NODE_ENV`, `BASE_URL`, `DB_FILE`, `PORT`)은 이미 들어 있다. 아래를 채운다.

| 키 | 설명 |
|---|---|
| `ADMIN_PASSWORD` | 관리자 비밀번호. 길고 추측하기 어렵게 |
| `CODE_SECRET` | 임의의 긴 문자열 |
| `KAKAO_CLIENT_ID`, `KAKAO_CLIENT_SECRET` | 카카오 앱 키 |
| `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` | 네이버 앱 키 |
| `SOLAPI_API_KEY`, `SOLAPI_API_SECRET`, `SOLAPI_SENDER` | 솔라피 |

저장 후 시작한다.
```bash
sudo systemctl restart waiting-web
sudo systemctl status waiting-web --no-pager
```

## 5. 확인
- `https://waiting.orandabowling.co.kr` 접속 (처음에는 인증서 발급에 몇십 초 걸릴 수 있음)
- 카카오·네이버 로그인, 문자 인증, 접수, `/admin` 로그인
- 카카오·네이버 콘솔에 운영 주소 Redirect/Callback URI가 등록되어 있어야 한다.
  - `https://waiting.orandabowling.co.kr/auth/kakao/callback`
  - `https://waiting.orandabowling.co.kr/auth/naver/callback`

## 운영
| 하고 싶은 일 | 명령 |
|---|---|
| 새 버전 반영 | `sudo bash /opt/waiting-web/deploy/update.sh` |
| 앱 로그 보기 | `sudo journalctl -u waiting-web -f` |
| 재시작 | `sudo systemctl restart waiting-web` |
| Caddy 로그 | `sudo journalctl -u caddy -f` |
| 수동 백업 | `sudo -u waiting /opt/waiting-web/deploy/backup.sh` |

- 데이터: `/var/lib/waiting-web/waiting.db`
- 백업: `/var/backups/waiting-web/` (14일 보관). 서버가 사라져도 복구할 수 있도록 **Lightsail 스냅샷**(자동 스냅샷 켜기)도 함께 쓰는 것을 권장한다.
- 복구: 서비스를 멈추고(`systemctl stop waiting-web`) 백업 파일을 `waiting.db`로 복사한 뒤 `chown waiting:waiting`, 다시 시작한다.

## 업체를 바꿀 때
새 서버에서 3~4단계를 반복하고, 기존 서버의 `waiting.db`와 `/etc/waiting-web.env`를 복사한 뒤 DNS의 A 레코드만 새 IP로 바꾼다.

## 주의
- 개인정보(전화번호 등)가 DB에 있다. 백업 파일을 외부에 공유하지 않는다.
- 관리자 로그인은 시도 횟수 제한이 없다. 오픈 전에 보강한다.
