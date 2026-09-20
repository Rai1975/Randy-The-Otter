import os
import uuid

from flask import Flask, jsonify, request
from flask_cors import CORS

from cover_letters import cover_letters_bp
from jobs_controller import jobs_bp
from portfolio import portfolio_bp
from resumes import resumes_bp


def create_app():
    app = Flask(__name__)
    app.config["JSON_SORT_KEYS"] = False

    CORS(app, allow_private_network=True)

    @app.before_request
    def assign_request_id():
        request.request_id = str(uuid.uuid4())

    app.register_blueprint(jobs_bp)
    app.register_blueprint(cover_letters_bp)
    app.register_blueprint(resumes_bp)
    app.register_blueprint(portfolio_bp)

    @app.route("/health", methods=["GET"])
    def health():
        return jsonify({
            "status": "ok",
            "request_id": getattr(request, "request_id", None),
        }), 200

    @app.errorhandler(400)
    def bad_request(error):
        return jsonify({
            "error": "Bad Request",
            "message": str(error),
            "request_id": getattr(request, "request_id", None),
        }), 400

    @app.errorhandler(404)
    def not_found(error):
        return jsonify({
            "error": "Not Found",
            "message": "Resource does not exist",
            "request_id": getattr(request, "request_id", None),
        }), 404

    @app.errorhandler(405)
    def method_not_allowed(error):
        return jsonify({
            "error": "Method Not Allowed",
            "message": str(error),
            "request_id": getattr(request, "request_id", None),
        }), 405

    @app.errorhandler(500)
    def internal_error(error):
        return jsonify({
            "error": "Internal Server Error",
            "request_id": getattr(request, "request_id", None),
        }), 500

    return app


app = create_app()

if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("ENV", "development") != "production"
    app.run(host="127.0.0.1", port=port, debug=debug)
