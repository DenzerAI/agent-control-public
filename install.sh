#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${AGENT_CONTROL_REPO_URL:-https://github.com/DenzerAI/agent-control.git}"
BRANCH="${AGENT_CONTROL_BRANCH:-main}"
DEST="${AGENT_CONTROL_HOME:-$HOME/agent-control}"

# Auto-Install standardmäßig an. Mit --no-auto-install (oder
# AGENT_CONTROL_NO_AUTO_INSTALL=1) fällt der Installer auf das alte
# Verhalten zurück: fehlende Voraussetzungen werden nur angezeigt, nicht
# selbst nachinstalliert.
AUTO_INSTALL="${AGENT_CONTROL_NO_AUTO_INSTALL:+0}"
AUTO_INSTALL="${AUTO_INSTALL:-1}"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_ACCENT=$'\033[38;5;173m'
  C_LINE=$'\033[38;5;240m'
  C_GREEN=$'\033[38;5;107m'
  C_GOLD=$'\033[38;5;179m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RESET=$'\033[0m'
else
  C_ACCENT=""
  C_LINE=""
  C_GREEN=""
  C_GOLD=""
  C_BOLD=""
  C_DIM=""
  C_RESET=""
fi

rule() {
  echo "${C_LINE}────────────────────────────────────────────────────────────${C_RESET}"
}

step() {
  echo
  echo "${C_ACCENT}▸${C_RESET} ${C_BOLD}$1${C_RESET}"
  [[ $# -gt 1 ]] && echo "${C_DIM}  $2${C_RESET}"
}

has_tty() {
  [[ -c /dev/tty ]] && { : </dev/tty >/dev/tty; } 2>/dev/null
}

ask() {
  local prompt="$1"
  local default="$2"
  local answer
  if has_tty; then
    read -r -p "$prompt [$default]: " answer </dev/tty
    echo "${answer:-$default}"
  else
    echo "$default"
  fi
}

yes_no() {
  local prompt="$1"
  local default="$2"
  local answer
  if has_tty; then
    read -r -p "$prompt [$default]: " answer </dev/tty
    answer="${answer:-$default}"
  else
    answer="$default"
  fi
  case "$(echo "$answer" | tr '[:upper:]' '[:lower:]')" in
    y|yes|j|ja|true|1) return 0 ;;
    *) return 1 ;;
  esac
}

# ANSI-Shadow-Logo "AGENT CONTROL" mit vertikalem Terracotta-Verlauf.
# install.sh laeuft per curl VOR dem Repo-Clone -> Banner ist hier
# eigenstaendig eingebettet (kein figlet, kein Sourcen der Repo-lib noetig).
# Gleiche Logik wie scripts/lib/agent-control-banner.sh; bei Aenderungen beide pflegen.
banner_ascii() {
  cat <<'ACBANNER'
 █████╗  ██████╗ ███████╗███╗   ██╗████████╗
██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║
██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║
██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║
╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝
 ██████╗ ██████╗ ███╗   ██╗████████╗██████╗  ██████╗ ██╗
██╔════╝██╔═══██╗████╗  ██║╚══██╔══╝██╔══██╗██╔═══██╗██║
██║     ██║   ██║██╔██╗ ██║   ██║   ██████╔╝██║   ██║██║
██║     ██║   ██║██║╚██╗██║   ██║   ██╔══██╗██║   ██║██║
╚██████╗╚██████╔╝██║ ╚████║   ██║   ██║  ██║╚██████╔╝███████╗
 ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚══════╝
ACBANNER
}

banner_logo() {
  # Override fuer Tests: AGENT_CONTROL_BANNER_MODE=truecolor|accent|plain
  local mode="${AGENT_CONTROL_BANNER_MODE:-}"
  if [[ -z "$mode" ]]; then
    if [[ ! -t 1 || -n "${NO_COLOR:-}" ]]; then
      mode="plain"
    elif command -v perl >/dev/null 2>&1 && { [[ "${COLORTERM:-}" == *truecolor* || "${COLORTERM:-}" == *24bit* ]] || [[ "${TERM:-}" == *-direct || "${TERM:-}" == iterm* || "${TERM:-}" == *-truecolor ]]; }; then
      mode="truecolor"
    else
      mode="accent"
    fi
  fi
  case "$mode" in
    truecolor)
      banner_ascii | perl -CSDA -Mutf8 -e '
        my @lines = <STDIN>; chomp @lines; my $total = scalar @lines;
        my ($tr,$tg,$tb)=(232,140,108); my ($br,$bg,$bb)=(176,74,48); my $sh=0.5;
        my $fill="\x{2588}";
        my %sc=map{$_=>1}("\x{2550}","\x{2551}","\x{2554}","\x{2557}","\x{255a}","\x{255d}");
        for my $i (0..$#lines){
          my $t=$total>1?$i/($total-1):0;
          my $r=int($tr+($br-$tr)*$t+0.5);my $g=int($tg+($bg-$tg)*$t+0.5);my $b=int($tb+($bb-$tb)*$t+0.5);
          my($sr,$sg,$sb)=(int($r*$sh+0.5),int($g*$sh+0.5),int($b*$sh+0.5));
          my $out="";my $cur=-1;
          for my $ch (split //,$lines[$i]){
            my $k=($ch eq " ")?2:($sc{$ch}?1:0);
            if($k!=$cur){ if($k==0){$out.=sprintf("\e[38;2;%d;%d;%dm",$r,$g,$b)} elsif($k==1){$out.=sprintf("\e[38;2;%d;%d;%dm",$sr,$sg,$sb)} else{$out.="\e[0m"} $cur=$k }
            $out.=$ch;
          }
          print $out,"\e[0m\n";
        }'
      ;;
    accent)
      if command -v perl >/dev/null 2>&1; then
        banner_ascii | perl -CSDA -Mutf8 -e '
          my $face="\e[38;5;173m";my $shade="\e[38;5;130m";my $reset="\e[0m";
          my %sc=map{$_=>1}("\x{2550}","\x{2551}","\x{2554}","\x{2557}","\x{255a}","\x{255d}");
          while(my $l=<STDIN>){chomp $l;my $out="";my $cur=-1;
            for my $ch (split //,$l){my $k=($ch eq " ")?2:($sc{$ch}?1:0);
              if($k!=$cur){if($k==0){$out.=$face}elsif($k==1){$out.=$shade}else{$out.=$reset}$cur=$k}$out.=$ch}
            print $out,$reset,"\n";}'
      else
        printf '%s' "$C_ACCENT"; banner_ascii; printf '%s' "$C_RESET"
      fi
      ;;
    *)
      banner_ascii
      ;;
  esac
}

banner() {
  echo
  banner_logo
  echo
  rule
  echo "${C_DIM}Dein persönlicher KI-Agent, lokal auf deinem Mac.${C_RESET}"
  echo "${C_DIM}Geführt eingerichtet. Keine externen Sends ohne deine Freigabe.${C_RESET}"
  rule
}

usage() {
  cat <<EOF
Agent Control one-line installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/DenzerAI/agent-control/${BRANCH}/install.sh | bash

With defaults:
  curl -fsSL https://raw.githubusercontent.com/DenzerAI/agent-control/${BRANCH}/install.sh | bash -- --yes --profile=client-demo --engine=codex

Environment:
  AGENT_CONTROL_HOME=$DEST
  AGENT_CONTROL_BRANCH=$BRANCH
  AGENT_CONTROL_REPO_URL=$REPO_URL
EOF
}

need_command() {
  local cmd="$1"
  local hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing: $cmd"
    echo "$hint"
    exit 1
  fi
}

# Findet den besten installierten Python-Interpreter mit Version >= 3.10.
# Gibt den Befehlsnamen auf stdout aus und liefert 0; sonst leeren String und 1.
find_python310() {
  local candidate
  for candidate in python3.14 python3.13 python3.12 python3.11 python3.10 python3 python; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 10) else 1)' >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

# Ruhige Stopp-Box im Banner-Stil: sagt in Laiensprache, was zu tun ist, dann exit 1.
preflight_stop() {
  local brew_ok="$1"  # 1 = vorhanden, 0 = fehlt
  echo
  rule
  echo "${C_GOLD}${C_BOLD}  Stopp. Es fehlen noch Voraussetzungen.${C_RESET}"
  rule
  echo "${C_DIM}  Agent Control braucht ein paar Bausteine, bevor es laufen kann.${C_RESET}"
  echo "${C_DIM}  Bitte führe die folgenden Schritte der Reihe nach im Terminal aus:${C_RESET}"
  echo
  local n=1
  if [[ "$brew_ok" != "1" ]]; then
    echo "  ${C_ACCENT}${n}.${C_RESET} ${C_BOLD}Homebrew installieren${C_RESET} ${C_DIM}(der Paketmanager für den Mac)${C_RESET}"
    echo "     ${C_DIM}/bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"${C_RESET}"
    echo "     ${C_DIM}Am Ende zeigt Homebrew zwei Zeilen an, die mit 'echo' beginnen.${C_RESET}"
    echo "     ${C_DIM}Diese beiden Zeilen bitte kopieren und ausführen, sonst wird brew nicht gefunden.${C_RESET}"
    echo "     ${C_DIM}(Apple Silicon: /opt/homebrew, ältere Intel-Macs: /usr/local)${C_RESET}"
    n=$((n + 1))
  fi
  echo "  ${C_ACCENT}${n}.${C_RESET} ${C_BOLD}Python, Node und Git installieren${C_RESET}"
  echo "     ${C_DIM}brew install python node git${C_RESET}"
  n=$((n + 1))
  echo "  ${C_ACCENT}${n}.${C_RESET} ${C_BOLD}Diesen Installer noch einmal starten${C_RESET}"
  echo "     ${C_DIM}curl -fsSL https://raw.githubusercontent.com/DenzerAI/agent-control/${BRANCH}/install.sh | bash${C_RESET}"
  echo
  echo "${C_DIM}  Es wurde noch nichts heruntergeladen oder installiert. Du kannst in Ruhe nachholen.${C_RESET}"
  rule
  exit 1
}

# Macht brew in der LAUFENDEN Shell verfügbar (Apple Silicon vs. Intel),
# damit es direkt nach der Homebrew-Installation ohne neue Shell nutzbar ist.
# Liefert 0, wenn brew danach auffindbar ist.
load_brew_shellenv() {
  if command -v brew >/dev/null 2>&1; then
    eval "$(brew shellenv)" 2>/dev/null || true
    return 0
  fi
  local candidate
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [[ -x "$candidate" ]]; then
      eval "$("$candidate" shellenv)" 2>/dev/null || true
      command -v brew >/dev/null 2>&1 && return 0
    fi
  done
  command -v brew >/dev/null 2>&1
}

# Installiert Homebrew non-interaktiv und macht es sofort nutzbar.
# Liefert 0 bei Erfolg, 1 bei Fehlschlag.
auto_install_homebrew() {
  step "Homebrew wird installiert…" "Der Paketmanager für den Mac."

  # Homebrew braucht einmal das Mac-Passwort (sudo). Im 'curl | bash'-Lauf ist
  # die normale Eingabe vom Pipe belegt, darum holen wir das Passwort bewusst
  # direkt vom Terminal und halten es kurz warm. Ohne diesen Schritt bricht der
  # Homebrew-Installer still ab und wir landen fälschlich in der Stopp-Box.
  local rc=0 keepalive=""
  if has_tty; then
    echo "${C_GOLD}  Der Mac fragt jetzt einmal nach deinem Passwort.${C_RESET}"
    echo "${C_DIM}  Tipp es ein und drücke Enter. Es bleibt beim Tippen unsichtbar, das ist normal.${C_RESET}"
    if ! sudo -v </dev/tty; then
      echo "${C_GOLD}  Ohne bestätigtes Passwort kann Homebrew nicht installiert werden.${C_RESET}"
      return 1
    fi
    # sudo-Zeitstempel warmhalten, solange die Installation läuft.
    ( while true; do sudo -n true 2>/dev/null; sleep 50; done ) &
    keepalive=$!
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty || rc=$?
    [[ -n "$keepalive" ]] && kill "$keepalive" 2>/dev/null || true
  else
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || rc=$?
  fi

  if [[ "$rc" -eq 0 ]]; then
    if load_brew_shellenv; then
      echo "${C_GREEN}✓ Homebrew installiert.${C_RESET}"
      return 0
    fi
    echo "${C_GOLD}  Homebrew wurde installiert, ist aber noch nicht auffindbar.${C_RESET}"
    return 1
  fi
  return 1
}

# Installiert ein fehlendes Paket via Homebrew, mit sichtbarem Fortschritt.
# $1 = brew-Paketname, $2 = Anzeigename. Liefert 0 bei Erfolg, 1 bei Fehlschlag.
auto_install_pkg() {
  local pkg="$1" label="$2"
  step "${label} wird installiert…"
  if brew install "$pkg"; then
    echo "${C_GREEN}✓ ${label} installiert.${C_RESET}"
    return 0
  fi
  return 1
}

# Versucht, fehlende Voraussetzungen selbst nachzuinstallieren.
# brew_ok=1 wenn Homebrew schon da ist. need_py/need_node/need_git = 1 wenn fehlend.
# Liefert 0, wenn am Ende alles vorhanden ist, sonst 1 (-> manuelle Stopp-Box).
auto_install_prereqs() {
  local brew_ok="$1" need_py="$2" need_node="$3" need_git="$4"

  if [[ "$brew_ok" != "1" ]]; then
    if ! command -v curl >/dev/null 2>&1; then
      return 1
    fi
    auto_install_homebrew || return 1
  else
    load_brew_shellenv || return 1
  fi

  # Sicherheitsnetz: ohne brew geht hier nichts weiter.
  command -v brew >/dev/null 2>&1 || return 1

  [[ "$need_py"   == "1" ]] && { auto_install_pkg python "Python" || return 1; }
  [[ "$need_node" == "1" ]] && { auto_install_pkg node "Node"   || return 1; }
  [[ "$need_git"  == "1" ]] && { auto_install_pkg git "Git"     || return 1; }

  return 0
}

# Prüft Homebrew, ein Python >= 3.10, node und git.
# Auto-Install (Default): fehlende Sachen werden selbst nachinstalliert,
# danach läuft der Installer normal weiter. Schlägt das fehl, erscheint die
# klare manuelle Stopp-Box. Mit --no-auto-install wird nur gestoppt.
preflight() {
  [[ "$(uname -s)" == "Darwin" ]] || return 0

  local brew_ok=1 missing=0
  command -v brew >/dev/null 2>&1 || { brew_ok=0; missing=1; }

  local need_py=0 need_node=0 need_git=0
  PY_BIN="$(find_python310 || true)"
  [[ -n "$PY_BIN" ]] || { need_py=1; missing=1; }

  command -v node >/dev/null 2>&1 || { need_node=1; missing=1; }
  command -v git  >/dev/null 2>&1 || { need_git=1;  missing=1; }

  if [[ "$missing" -eq 1 ]]; then
    if [[ "$AUTO_INSTALL" == "1" ]]; then
      step "Voraussetzungen werden eingerichtet" "Fehlende Bausteine werden jetzt automatisch nachinstalliert."
      if auto_install_prereqs "$brew_ok" "$need_py" "$need_node" "$need_git"; then
        # Frischen Python-Interpreter nach der Installation suchen.
        PY_BIN="$(find_python310 || true)"
        if [[ -z "$PY_BIN" ]] || ! command -v node >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
          preflight_stop "$( command -v brew >/dev/null 2>&1 && echo 1 || echo 0 )"
        fi
      else
        # Ehrlicher Fallback: Auto-Install fehlgeschlagen -> klare Anleitung.
        preflight_stop "$( command -v brew >/dev/null 2>&1 && echo 1 || echo 0 )"
      fi
    else
      preflight_stop "$brew_ok"
    fi
  fi

  export AGENT_CONTROL_PYTHON="$PY_BIN"
  step "Voraussetzungen geprüft" "Homebrew, Python ($("$PY_BIN" --version 2>&1)), Node und Git sind da."
}

wait_for_server() {
  local url="http://127.0.0.1:8890/api/system-status"
  for _ in $(seq 1 40); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# Der gesamte Ausführungsteil liegt in main(). Grund: bei 'curl | bash' liest
# die Shell das Skript häppchenweise vom Pipe und führt es währenddessen aus.
# Ein Unterprozess, der von stdin liest (z. B. der Homebrew-Installer), würde
# sonst den noch ungelesenen Rest dieses Skripts wegschnappen, und der Lauf
# bräche nach Homebrew einfach ab. Weil main() erst in der LETZTEN Zeile
# aufgerufen wird, ist das ganze Skript bis dahin schon vollständig eingelesen.
main() {
PASSTHRU_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --help|-h)
      usage
      exit 0
      ;;
    --no-auto-install)
      AUTO_INSTALL=0
      # An das innere Skript per Env weiterreichen, nicht als Argument.
      export AGENT_CONTROL_NO_AUTO_INSTALL=1
      ;;
    *)
      PASSTHRU_ARGS+=("$arg")
      ;;
  esac
done
set -- "${PASSTHRU_ARGS[@]+"${PASSTHRU_ARGS[@]}"}"

banner
echo
echo "${C_DIM}Drücke bei jeder Frage einfach Enter, um den Vorschlag zu übernehmen.${C_RESET}"
echo "${C_DIM}Der Chat öffnet sich am Ende von selbst.${C_RESET}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "${C_GOLD}Hinweis: Dieser Alpha-Installer ist aktuell auf macOS ausgelegt.${C_RESET}"
fi

need_command "curl" "curl wird gebraucht, um Agent Control zu laden."

if [[ "$(uname -s)" == "Darwin" ]]; then
  # Früher Preflight: stoppt sauber VOR dem Klonen, wenn Voraussetzungen fehlen.
  # So entsteht kein halber ~/agent-control-Ordner.
  preflight
else
  need_command "git" "Installiere zuerst Apples Command Line Tools: xcode-select --install"
fi

if [[ -d "$DEST/.git" ]]; then
  step "Vorhandene Installation gefunden" "$DEST"
  if yes_no "Vor dem Setup aktualisieren?" "Y"; then
    git -C "$DEST" fetch origin "$BRANCH"
    git -C "$DEST" checkout "$BRANCH"
    git -C "$DEST" pull --ff-only origin "$BRANCH"
  fi
elif [[ -e "$DEST" ]]; then
  echo "Installation nicht möglich: $DEST existiert bereits, ist aber kein Git-Checkout."
  echo "Bitte Ordner verschieben oder löschen und den Installer erneut starten."
  exit 1
else
  parent="$(dirname "$DEST")"
  mkdir -p "$parent"
  step "Code laden" "$REPO_URL#$BRANCH"
  git clone --branch "$BRANCH" "$REPO_URL" "$DEST"
fi

cd "$DEST"

RAW_ARG_COUNT=$#
INSTALL_ARGS=("$@")
if [[ "${#INSTALL_ARGS[@]}" -eq 0 ]]; then
  INSTALL_ARGS=(--install-tools --package-plan)
fi

BOOTSTRAP_DRY_RUN=0
for arg in "${INSTALL_ARGS[@]}"; do
  [[ "$arg" == "--dry-run" ]] && BOOTSTRAP_DRY_RUN=1
done

if has_tty; then
  step "Geführtes Setup starten" "Profil, Name, Engine und optionale Module."
  bash scripts/install-agent-control.sh "${INSTALL_ARGS[@]}" </dev/tty
else
  step "Automatisches Setup starten" "Ohne Terminal-Eingabe wird das Demo-Profil genutzt."
  if [[ "$RAW_ARG_COUNT" -eq 0 ]]; then
    bash scripts/install-agent-control.sh --yes --profile=client-demo --engine=codex --install-tools --package-plan
  else
    bash scripts/install-agent-control.sh "${INSTALL_ARGS[@]}"
  fi
fi

echo
if [[ "$BOOTSTRAP_DRY_RUN" -eq 1 ]]; then
  echo "Dry-run complete. Agent Control was not started."
  exit 0
fi

if yes_no "Agent Control jetzt starten?" "Y"; then
  mkdir -p logs
  if curl -fsS http://127.0.0.1:8890/api/system-status >/dev/null 2>&1; then
    echo "${C_GREEN}✓ Agent Control läuft bereits.${C_RESET}"
  else
    step "Agent Control starten" "Der lokale Chat wird unter http://127.0.0.1:8890 geöffnet."
    nohup bash scripts/start.sh > logs/start.log 2> logs/start.err.log &
    echo $! > .server.pid
    if wait_for_server; then
      echo "${C_GREEN}✓ Agent Control läuft.${C_RESET}"
    else
      echo "${C_GOLD}Gestartet, aber der Health-Check antwortet noch nicht. Prüfe logs/start.err.log.${C_RESET}"
    fi
  fi
  if [[ "$(uname -s)" == "Darwin" ]] && command -v open >/dev/null 2>&1; then
    open http://127.0.0.1:8890 >/dev/null 2>&1 || true
  fi
fi

echo
rule
echo "${C_ACCENT}${C_BOLD}✓ Fertig. Du kannst jetzt chatten.${C_RESET}"
echo "${C_BOLD}  Chat öffnen:${C_RESET} http://127.0.0.1:8890"
rule
echo "${C_DIM}  Ordner:        $DEST${C_RESET}"
echo "${C_DIM}  Neu starten:   cd \"$DEST\" && bash scripts/start.sh${C_RESET}"
echo
}

# Ganzes Skript ist jetzt eingelesen -> sicher ausführen, ohne dass ein
# Unterprozess den Rest vom Pipe wegschnappen kann.
main "$@"
