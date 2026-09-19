from flask import Blueprint, request, jsonify

jobs_bp = Blueprint("jobs", __name__)


@jobs_bp.route("/job-summary", methods=["POST"])
def job_summary():
    """Echo back the received JSON packet.

    Expects: Content-Type: application/json with any JSON object body.
    Returns: the same packet plus request_id.
    """
    if not request.is_json:
        return jsonify({
            "error": "Bad Request",
            "message": "Request body must be JSON",
            "request_id": getattr(request, "request_id", None),
        }), 400

    data = request.get_json(silent=True)
    if data is None:
        return jsonify({
            "error": "Bad Request",
            "message": "Malformed JSON body",
            "request_id": getattr(request, "request_id", None),
        }), 400

    return jsonify({
        "echo": data,
        "request_id": getattr(request, "request_id", None),
    }), 200
