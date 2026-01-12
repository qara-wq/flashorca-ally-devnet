from flask import Blueprint, current_app, request, session, jsonify
import os, time, base64, base58
import requests
from nacl.signing import VerifyKey
from nacl.exceptions import BadSignatureError
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED

# Create blueprint for SIWS/RPC endpoints
bp = Blueprint("rpc_siws", __name__)

START_TS = int(time.time())

# Upstream config
RPC_UPSTREAM = (
        os.environ.get("RPC_UPSTREAM")
        or os.environ.get("HELIUS_RPC_URL")
        or os.environ.get("PRIVATE_RPC_URL")
        or os.environ.get("RPC_URL")
        or "https://isidora-7vlifz-fast-mainnet.helius-rpc.com"
)
# Optional: multiple upstreams for fanout (comma-separated)
_upstreams_env = os.environ.get("RPC_UPSTREAMS", "")
RPC_UPSTREAMS = [u.strip() for u in _upstreams_env.split(",") if u.strip()]
if not RPC_UPSTREAMS:
    RPC_UPSTREAMS = [RPC_UPSTREAM]
else:
    # Ensure primary is first if not included
    if RPC_UPSTREAM not in RPC_UPSTREAMS:
        RPC_UPSTREAMS.insert(0, RPC_UPSTREAM)
_DEFAULT_ALLOW = {
    "getLatestBlockhash",
    "getBalance",
    "getBlockHeight",
    "getBlock",
    "getTransaction",
    "getAccountInfo",
    "getProgramAccounts",
    "getMultipleAccounts",
    "getSignatureStatuses",
    "getTokenAccountsByOwner",
    "getParsedTokenAccountsByOwner",
    "getTokenAccountBalance",
    "getMinimumBalanceForRentExemption",
    "getSlot",
    "getEpochInfo",
    "getVersion",
    "simulateTransaction",
    "sendTransaction",
    "requestAirdrop",
    "getSignaturesForAddress",
}
_allow_env = os.environ.get("RPC_METHOD_ALLOWLIST")
if _allow_env:
    RPC_METHOD_ALLOWLIST = set(x.strip() for x in _allow_env.split(",") if x.strip())
else:
    RPC_METHOD_ALLOWLIST = _DEFAULT_ALLOW

# Optional: explicit blocklist via env (comma-separated)
_block_env = os.environ.get("RPC_METHOD_BLOCKLIST")
if _block_env:
    RPC_METHOD_BLOCKLIST = set(x.strip() for x in _block_env.split(",") if x.strip())
else:
    RPC_METHOD_BLOCKLIST = set()

def _public_origin() -> str:
    for key in ("FLASHORCA_PUBLIC_ORIGIN", "PUBLIC_ORIGIN", "PUBLIC_BASE_URL"):
        raw = os.environ.get(key)
        if raw:
            return raw.strip().rstrip("/")
    try:
        return request.host_url.rstrip("/")
    except RuntimeError:
        return "https://flashorca.com"

def _siws_chain_id() -> str:
    explicit = os.environ.get("SIWS_CHAIN_ID") or os.environ.get("SOLANA_CHAIN_ID")
    if explicit:
        return explicit.strip()
    cluster = (os.environ.get("SOLANA_CLUSTER") or "").lower()
    if "devnet" in cluster:
        return "solana:devnet"
    if "testnet" in cluster:
        return "solana:testnet"
    rpc_hint = (os.environ.get("RPC_UPSTREAM") or os.environ.get("RPC_URL") or RPC_UPSTREAM or "").lower()
    if "devnet" in rpc_hint:
        return "solana:devnet"
    if "testnet" in rpc_hint:
        return "solana:testnet"
    return "solana:mainnet"


def _is_allowed_method(method_name: str) -> bool:
    """
    Default policy:
      - If RPC_METHOD_ALLOWLIST is explicitly provided via env, require membership.
      - Else, allow all read methods starting with 'get', plus simulateTransaction/sendTransaction/requestAirdrop.
      - Then apply an explicit blocklist override.
    """
    # Blocklist wins
    if method_name in RPC_METHOD_BLOCKLIST:
        return False
    # If user provided an explicit allowlist via env, respect it strictly
    if _allow_env:
        return method_name in RPC_METHOD_ALLOWLIST
    # Default-open read policy
    if method_name.startswith("get"):
        return True
    if method_name in {"simulateTransaction", "sendTransaction", "requestAirdrop"}:
        return True
    return False


def _coerce_to_bytes(v):
    """
    다양한 JSON 직렬화 형태를 안전하게 bytes로 변환:
    - base64 / base58 / hex 문자열
    - 일반 UTF-8 문자열(최후 fallback)
    - 숫자 배열(list/tuple)
    - Node Buffer JSON: {"type":"Buffer","data":[...]}
    - 숫자 키 dict: {"0":12, "1":34, ...} (Uint8Array 직렬화 형태)
    """
    import base64 as _b64
    import base58 as _b58

    if v is None:
        return b""

    if isinstance(v, (bytes, bytearray)):
        return bytes(v)

    if isinstance(v, str):
        # 1) base64(strict) → 2) base58 → 3) hex, 실패 시 UTF-8 인코딩
        for fn in (
                lambda s: _b64.b64decode(s, validate=True),
                lambda s: _b58.b58decode(s),
                lambda s: bytes.fromhex(s),
        ):
            try:
                return fn(v)
            except Exception:
                pass
        return v.encode("utf-8")

    if isinstance(v, dict):
        # Node Buffer 직렬화 형태
        if "data" in v and isinstance(v["data"], list):
            return bytes(int(x) & 0xFF for x in v["data"])
        # {"0":12, "1":34, ...} 형태
        try:
            items = sorted((int(k), int(v[k])) for k in v.keys())
            return bytes([b for _, b in items])
        except Exception:
            pass

    if isinstance(v, (list, tuple)):
        return bytes(int(x) & 0xFF for x in v)

    # 그 외 타입은 bytes()로 최후 시도
    try:
        return bytes(v)
    except Exception:
        raise TypeError(f"Cannot coerce to bytes: {type(v).__name__}")


# ---------- (A) SIWS: signInInput 생성 ----------
@bp.get("/api/siws/create")
def siws_create():
    # 지갑이 메시지를 구성하므로, 우리는 표준 입력 객체를 제안 (nonce/도메인/issuedAt 등)
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    nonce = os.urandom(8).hex()
    session["siws"] = {"nonce": nonce, "issued_at": now_iso, "ts": int(time.time())}

    # 필요한 최소 필드만: domain/nonce/issuedAt/chainId 등
    sign_in_input = {
        "domain": request.host,
        "version": "1",
        "chainId": _siws_chain_id(),
        "nonce": nonce,
        "issuedAt": now_iso,
        "statement": "Sign in to FlashOrca.",
        "resources": [f"{_public_origin()}/docs/terms"],
    }
    return jsonify(sign_in_input)


# ---------- (B) SIWS: 검증 ----------
@bp.post("/api/siws/verify")
def siws_verify():
    data = request.get_json(force=True)
    input_obj = data.get("input") or {}
    output = data.get("output") or {}
    acct = (output.get("account") or {})
    addr_b58 = acct.get("address") or data.get("publicKey") or output.get("address")
    if not addr_b58:
        return ("missing address", 400)

    signed_message = _coerce_to_bytes(output.get("signedMessage"))
    signature = _coerce_to_bytes(output.get("signature"))

    # 1) nonce 재사용 방지/만료(예: 5분)
    s = session.get("siws")
    if not s or s["nonce"] != input_obj.get("nonce") or (int(time.time()) - s["ts"] > 300):
        return ("invalid nonce", 400)

    # 2) 메시지 서명 검증 (Ed25519)
    # 주소 정규화: 혹시 'ed25519:BASE58' 같은 스킴이 포함되면 분리
    if isinstance(addr_b58, str) and ":" in addr_b58:
        addr_b58 = addr_b58.split(":")[-1]

    try:
        pubkey = base58.b58decode(addr_b58)
    except Exception as e:
        current_app.logger.warning(f"invalid address/base58: {addr_b58} err={e}")
        return ("invalid address", 400)

    if len(pubkey) != 32:
        current_app.logger.warning(f"invalid pubkey length: {len(pubkey)} (expected 32)")
        return ("invalid address", 400)

    if len(signature) != 64:
        current_app.logger.warning(f"invalid signature length: {len(signature)} (expected 64)")
        return ("invalid signature", 400)

    try:
        VerifyKey(pubkey).verify(signed_message, signature)
    except Exception as e:
        current_app.logger.warning(f"bad signature verify failure: {e}")
        return ("bad signature", 400)

    # 3) (권장) 메시지 파싱 후 input과의 정합성(domain/nonce/issuedAt/chainId 등)도 검사
    #    - Phantom의 SIWS 레포/유틸이 JS용 검증 도우미를 제공합니다(백엔드는 동일 로직 구현 필요).  [oai_citation:9‡GitHub](https://github.com/phantom/sign-in-with-solana)

    session["user"] = addr_b58
    return ("ok", 200)


# ---------- (R) JSON-RPC Proxy: hide API key ----------
def _post_once(url, payload, headers, timeout):
    try:
        return requests.post(url, json=payload, headers=headers, timeout=timeout)
    except Exception as e:
        current_app.logger.warning(f"upstream {url} error: {type(e).__name__}: {e}")
        return None


def _merge_signature_statuses(responses, original_id):
    """
    Merge the first non-null status per index across upstream responses.
    Keep the highest slot context when available.
    """
    best_context = None
    merged_value = None
    jsonrpc = "2.0"
    for r in responses:
        if not r:
            continue
        try:
            j = r.json()
        except Exception:
            continue
        if not isinstance(j, dict) or "result" not in j or "value" not in j["result"]:
            continue
        jsonrpc = j.get("jsonrpc", jsonrpc)
        ctx = j["result"].get("context")
        val = j["result"].get("value")
        if not isinstance(val, list):
            continue
        if merged_value is None:
            merged_value = [None] * len(val)
        # choose first non-null per index
        for i in range(len(val)):
            if merged_value[i] is None and val[i] is not None:
                merged_value[i] = val[i]
        # keep highest-slot context
        if ctx and isinstance(ctx, dict):
            if best_context is None or ctx.get("slot", 0) > best_context.get("slot", 0):
                best_context = ctx
    if merged_value is None:
        # fallback: first valid JSON with expected shape or an empty baseline
        for r in responses:
            try:
                j = r.json()
                if "result" in j and "value" in j["result"]:
                    return j
            except Exception:
                pass
        return {"jsonrpc": jsonrpc, "result": {"context": best_context or {}, "value": []}, "id": original_id}
    return {"jsonrpc": jsonrpc, "result": {"context": best_context or {}, "value": merged_value}, "id": original_id}


@bp.route("/rpc", methods=["POST", "OPTIONS"])
def rpc_proxy():
    # CORS preflight handled by Flask-CORS globally; still short-circuit OPTIONS
    if request.method == "OPTIONS":
        return ("", 204)

    try:
        payload = request.get_json(force=True, silent=False)
    except Exception as e:
        current_app.logger.warning(f"/rpc bad json: {e}")
        return jsonify({"jsonrpc": "2.0", "error": {"code": -32700, "message": "Parse error"}, "id": None}), 400

    # 단일 또는 배치(batch) 요청 모두 허용
    def _methods_from(p):
        if isinstance(p, list):
            for item in p:
                if isinstance(item, dict) and "method" in item:
                    yield item["method"]
        elif isinstance(p, dict) and "method" in p:
            yield p["method"]

    # allow policy check
    for m in _methods_from(payload):
        if not _is_allowed_method(m):
            current_app.logger.warning(f"/rpc blocked method: {m}")
            return jsonify({
                "jsonrpc": "2.0",
                "error": {"code": -32601, "message": f"Method {m} not allowed by proxy policy"},
                "id": None,
            }), 403

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    # Strategy depends on method(s)
    timeout = (5, 30)

    # Single-request JSON-RPC
    if isinstance(payload, dict):
        method = payload.get("method")

        # (1) Fanout for write paths so at least one leader sees the tx quickly
        if method in {"sendTransaction", "requestAirdrop"} and len(RPC_UPSTREAMS) > 1:
            with ThreadPoolExecutor(max_workers=len(RPC_UPSTREAMS)) as ex:
                futs = {ex.submit(_post_once, url, payload, headers, timeout): url for url in RPC_UPSTREAMS}
                done, _ = wait(futs, return_when=FIRST_COMPLETED)
                # Prefer the first completed OK response
                for f in done:
                    r = f.result()
                    if r and r.ok:
                        try:
                            data = r.json()
                            return jsonify(data), r.status_code
                        except Exception:
                            pass
                # If the first-completed set wasn't OK, scan all for a usable OK
                for f in futs:
                    r = f.result()
                    if r and r.ok:
                        try:
                            data = r.json()
                            return jsonify(data), r.status_code
                        except Exception:
                            continue
                return jsonify({"jsonrpc": "2.0", "error": {"code": 502, "message": "All upstreams failed"},
                                "id": payload.get("id")}), 502

        # (2) Merge read path for signature statuses to avoid long-lived nulls
        if method == "getSignatureStatuses" and len(RPC_UPSTREAMS) > 1:
            with ThreadPoolExecutor(max_workers=len(RPC_UPSTREAMS)) as ex:
                futs = [ex.submit(_post_once, url, payload, headers, timeout) for url in RPC_UPSTREAMS]
                resps = [f.result() for f in futs]
            merged = _merge_signature_statuses(resps, payload.get("id"))
            return jsonify(merged), 200

        # (3) Default: primary only
        try:
            resp = requests.post(RPC_UPSTREAMS[0], json=payload, headers=headers, timeout=timeout)
        except requests.Timeout:
            return jsonify(
                {"jsonrpc": "2.0", "error": {"code": 504, "message": "Upstream timeout"}, "id": payload.get("id")}), 504
        except Exception as e:
            current_app.logger.error(f"/rpc upstream error: {type(e).__name__}: {e}")
            return jsonify(
                {"jsonrpc": "2.0", "error": {"code": 502, "message": "Upstream error"}, "id": payload.get("id")}), 502

        try:
            data = resp.json()
            return jsonify(data), resp.status_code
        except ValueError:
            return jsonify({"jsonrpc": "2.0", "error": {"code": 502, "message": "Invalid JSON from upstream"},
                            "id": payload.get("id")}), 502

    # Batch requests → keep simple: use primary only
    try:
        resp = requests.post(RPC_UPSTREAMS[0], json=payload, headers=headers, timeout=timeout)
    except requests.Timeout:
        return jsonify({"jsonrpc": "2.0", "error": {"code": 504, "message": "Upstream timeout"}, "id": None}), 504
    except Exception as e:
        current_app.logger.error(f"/rpc upstream error: {type(e).__name__}: {e}")
        return jsonify({"jsonrpc": "2.0", "error": {"code": 502, "message": "Upstream error"}, "id": None}), 502

    try:
        data = resp.json()
        return jsonify(data), resp.status_code
    except ValueError:
        return jsonify(
            {"jsonrpc": "2.0", "error": {"code": 502, "message": "Invalid JSON from upstream"}, "id": None}), 502


# ---------- (Z) K8s Probes: /healthz ----------
@bp.get("/healthz")
def healthz():
    """
    Kubernetes liveness/readiness probe endpoint.
    Returns 200 JSON when the app is healthy and ready to serve traffic.
    Keep it lightweight and free of slow external checks.
    """
    try:
        # Minimal self-checks (add more if you add dependencies like DB/cache)
        secret_ok = bool(current_app.secret_key)

        if not secret_ok:
            # Misconfiguration means not ready
            return jsonify({
                "status": "error",
                "reason": "missing secret key",
                "uptime_sec": int(time.time() - START_TS),
            }), 500

        return jsonify({
            "status": "ok",
            "uptime_sec": int(time.time() - START_TS),
            "now": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "version": os.environ.get("GIT_SHA") or os.environ.get("VERSION") or "dev",
        }), 200
    except Exception as e:
        # Any unexpected exception counts as unhealthy
        return jsonify({
            "status": "error",
            "reason": str(e),
            "uptime_sec": int(time.time() - START_TS),
        }), 500


# ---------- (C) 레거시: nonce 메시지 서명 ----------
@bp.get("/api/auth/nonce")
def legacy_nonce():
    nonce = os.urandom(16).hex()
    ts = int(time.time())
    session["legacy"] = (nonce, ts)
    msg = f"Sign-in with Solana\nnonce={nonce}\nissued_at={ts}\ndomain={request.host}"
    return jsonify({"nonce": nonce, "message": msg})


@bp.post("/api/auth/verify")
def legacy_verify():
    data = request.get_json(force=True)
    pubkey_b58 = data["publicKey"]
    sig_b64 = data["signature"]
    nonce = data["nonce"]

    # 1) 재사용/만료 방지
    s = session.get("legacy")
    if not s or s[0] != nonce or time.time() - s[1] > 300:
        return ("invalid nonce", 400)

    # 2) 메시지 재구성 & 검증
    message = f"Sign-in with Solana\nnonce={nonce}\nissued_at={s[1]}\ndomain={request.host}".encode()
    try:
        VerifyKey(base58.b58decode(pubkey_b58)).verify(message, base64.b64decode(sig_b64))
    except BadSignatureError:
        return ("bad signature", 400)

    session["user"] = pubkey_b58
    return ("ok", 200)

# if __name__ == "__main__":
#     app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5050)))
