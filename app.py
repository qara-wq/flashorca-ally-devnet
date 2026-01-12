import os

from flask import Flask, jsonify, render_template

from server.siws import bp as rpc_siws_bp

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-secret")
cookie_domain = os.getenv("SESSION_COOKIE_DOMAIN")
if cookie_domain:
    app.config["SESSION_COOKIE_DOMAIN"] = cookie_domain
app.register_blueprint(rpc_siws_bp)


def _get_public_origin() -> str:
    for key in ("ALLY_PUBLIC_ORIGIN", "FLASHORCA_PUBLIC_ORIGIN", "PUBLIC_ORIGIN", "PUBLIC_BASE_URL"):
        raw = os.environ.get(key)
        if raw:
            return raw.strip().rstrip("/")
    return ""


@app.get("/")
def ally_devnet_home():
    return render_template(
        "ally_devnet_index.html",
        public_origin=_get_public_origin(),
    )


@app.get("/api/env")
def api_env():
    rpc_url = os.getenv("RPC_UPSTREAM") or os.getenv("RPC_URL") or ""
    return jsonify({
        "rpc_url": rpc_url,
        "is_devnet": "devnet" in rpc_url.lower(),
    })


@app.get("/verify_token")
def verify_token():
    return jsonify({"logged_in": False}), 401


@app.get("/api/auth/exchange_jwt")
def exchange_jwt():
    return jsonify({"msg": "no active session"}), 401


@app.post("/api/logout")
def api_logout():
    return ("", 204)


@app.get("/healthz")
def healthz():
    return ("", 204)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8000")), debug=False)
