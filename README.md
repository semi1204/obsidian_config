# Obsidian configuration

Obsidian의 편집 환경과 로컬 커스텀 플러그인을 한곳에 보관한 설정 저장소입니다. 노트, 첨부 파일, 작업 공간 상태, Anki 데이터베이스, 복습 기록, 동기화 보고서와 절대 경로는 포함하지 않습니다.

## 포함된 기능

- `config/`: Vim 모드, 단축키, 테마 색상, Notebook Navigator, Spaced Repetition 설정과 CSS 스니펫
- `plugins/spaced-repetition-anki/`: Markdown·수식·이미지·표·중첩 목록 카드 파서와 AnkiConnect 동기화
- `plugins/paste-mode-tables/`: 목록 안 표 붙여넣기, 실제 셀 편집, `<`·`^` 마커 기반 셀 병합
- `plugins/list-marker-input/`: `-`와 `1.` 목록 전환 및 `1. → a. → i.` 중첩 번호 표시
- `plugins/navigator-vim-keys/`: 폴더에서 `j/k/h/l`, `Space`로 파일 목록 확정, `Enter`로 노트 열기
- `plugins/vim-im-control/`: Vim의 `Esc`, `o`, `O`와 macOS 한글 입력기 전환 보정

## 요구 버전

- Obsidian 1.11.7 이상
- Spaced Repetition 1.15.4
- Paste Mode 5.0.2
- Notebook Navigator 3.2.2
- macOS에서 Anki 전송 시 Anki와 AnkiConnect

세 패치 스크립트는 지정한 원본에서 예상 코드가 정확히 한 번 발견될 때만 빌드합니다. 플러그인 버전이 다르면 중단되므로 해당 버전의 공식 플러그인을 먼저 설치하세요.

## 설치

보관함을 닫은 뒤 실행합니다. 설치기는 변경 대상만 시간별 백업 폴더에 복사하고 설정과 커스텀 플러그인을 적용합니다.

```sh
python3 install.py "/path/to/vault"
```

macOS의 `vim-im-control`용 `im-select`를 만들려면 Xcode Command Line Tools의 `clang`이 필요합니다. 빌드할 수 없으면 다른 설정은 설치되고 해당 실행 파일만 제외됩니다.

설치 후 Obsidian을 다시 열고 커뮤니티 플러그인을 활성화합니다. Anki 전체 동기화 단축키는 `Ctrl+Shift+A`입니다. iOS에서는 같은 파서와 Obsidian 복습을 사용하지만 로컬 AnkiConnect 전송 명령은 표시하지 않습니다.

## 카드 문법

```markdown
#flashcards/이론/원가

한 줄 질문 :: 답

여러 줄 질문
???
답과 표, 이미지, 수식

문장 속 {{빈칸}}
같은 카드로 묶기 {{1;;첫 답}} / {{1;;둘째 답}}
```

`#flashcards/이론/원가`는 `<보관함 이름>::이론::원가` Anki 덱으로 전송됩니다. 첫 동기화에서 `<!--ANKI:...-->` 식별자가 노트에 추가되며 이후 내용과 덱만 갱신하고 Anki 학습 일정은 유지합니다. 전송 후 Anki 동기화도 이어서 요청합니다.

## 표 병합

Obsidian의 표 셀을 드래그한 뒤 우클릭하여 **셀 병합** 또는 **병합 해제**를 선택합니다. 원문에는 병합된 셀을 나타내는 마커가 저장됩니다.

- `<`: 왼쪽 셀에 병합
- `^`: 위쪽 셀에 병합

이 표기법은 표준 Markdown 확장이므로 다른 Markdown 앱에서는 마커가 글자로 보일 수 있습니다.

## 테스트

```sh
node --test plugins/list-marker-input/verify-rules.cjs
node --test plugins/paste-mode-tables/verify-list.cjs \
  plugins/paste-mode-tables/verify-cell-ranges.cjs \
  plugins/paste-mode-tables/verify-merge.cjs
node --test plugins/vim-im-control/verify-fast-open.cjs
```

Spaced Repetition 테스트는 먼저 패치된 번들을 만든 다음 실행합니다.

```sh
python3 plugins/spaced-repetition-anki/build.py \
  --base /path/to/upstream/main.js \
  --output /tmp/obsidian-sr-build
OSR_BUNDLE=/tmp/obsidian-sr-build/main.js \
  node --test plugins/spaced-repetition-anki/verify.cjs
```

## 업스트림

- [Spaced Repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition)
- [Paste Mode](https://github.com/jglev/obsidian-paste-mode)
- [Notebook Navigator](https://github.com/johansan/notebook-navigator)
- [Vim IM Control](https://github.com/hideakitai/obsidian-vim-im-control)
- [im-select](https://github.com/daipeihust/im-select)

각 업스트림에서 가져온 코드에는 해당 프로젝트의 라이선스가 적용됩니다. `vim-im-control`과 `im-select`의 라이선스 전문은 해당 폴더에 보존했습니다.

