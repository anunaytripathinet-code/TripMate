# ====================================================
# TripMate AI - Flask Web Server (server.py)
# ====================================================
# Backend server for TripMate AI prototype:
# 1. Serves frontend files (index.html, style.css, script.js)
# 2. Provides secure Gemini AI reasoning endpoint (/api/gemini/explain)
# 3. Protects secret keys stored in .env

import os
import json
import urllib.request
import urllib.error
from flask import Flask, jsonify, request, send_from_directory
from dotenv import load_dotenv

# Load secret environment variables from .env
load_dotenv()

# Initialize Flask app
app = Flask(__name__, static_folder=None)

# ----------------------------------------------------
# Route 1: Serve Main Web Application (index.html)
# ----------------------------------------------------
@app.route('/')
def home():
    return send_from_directory('.', 'index.html')

# ----------------------------------------------------
# Route 2: Provide Configuration (Safe Client Config)
# ----------------------------------------------------
@app.route('/api/config')
def get_config():
    # Only report whether Gemini key is configured, never send the key itself!
    gemini_key = os.getenv('GEMINI_API_KEY', '').strip()
    has_gemini = bool(gemini_key and gemini_key != 'YOUR_GEMINI_API_KEY_HERE')
    return jsonify({
        'hasGeminiKey': has_gemini
    })

# ----------------------------------------------------
# Route 3: Gemini Itinerary Insights & Trade-Offs
# ----------------------------------------------------
@app.route('/api/gemini/explain', methods=['POST'])
def gemini_explain():
    gemini_key = os.getenv('GEMINI_API_KEY', '').strip()
    data = request.get_json(silent=True) or {}

    trip = data.get('trip', {})
    stops = data.get('stops', [])
    itinerary = data.get('itinerary', [])
    delay_minutes = data.get('delayMinutes', 0)
    overflow = data.get('overflow', False)

    # 1. Fallback heuristic generator if Gemini key is missing
    def generate_fallback_insights():
        interests = trip.get('interests', 'general travel')
        explanations = []
        rankings = []

        # Ranking based on must_visit flag and interests matching
        for stop in stops:
            score = 10 if stop.get('type') == 'must_visit' else 5
            category = stop.get('category', '').lower()
            name = stop.get('name', '')
            if any(term.strip().lower() in (category + ' ' + name.lower()) for term in interests.split(',')):
                score += 3
            rankings.append({
                'name': name,
                'priority': 'High' if score >= 10 else 'Medium',
                'reason': f"Matches traveler interest ({interests})" if score > 10 else ("Designated Must-Visit stop" if stop.get('type') == 'must_visit' else "Optional scenic stop")
            })

        # Trade-off advice
        if delay_minutes > 0:
            if overflow:
                explanations.append(f"A delay of {delay_minutes} minutes pushes your schedule beyond the daily limit. To protect your Must-Visit spots, shorten or omit lower-priority optional stops.")
            else:
                explanations.append(f"A delay of {delay_minutes} minutes was absorbed within your remaining daily buffer without exceeding your cutoff time.")
        else:
            explanations.append("Your current schedule fits within your target daily hours with comfortable visit intervals.")

        return {
            'source': 'heuristic_fallback',
            'explanation': " ".join(explanations),
            'rankings': rankings,
            'note': 'Generated via built-in scheduler. (To enable AI commentary, add your GEMINI_API_KEY in .env)'
        }

    # If no key or placeholder, return clean fallback
    if not gemini_key or gemini_key == 'YOUR_GEMINI_API_KEY_HERE':
        return jsonify(generate_fallback_insights())

    # 2. Call Gemini API securely from backend
    prompt_content = f"""
You are an expert travel logistics assistant for TripMate AI.
You must analyze ONLY the provided trip data.
CRITICAL RULES:
- Do NOT invent new places, coordinates, opening hours, road conditions, or travel times.
- All numbers, route durations, and visit times provided are fixed estimates computed by the app.
- Provide a brief, concise explanation (max 3 sentences) analyzing the schedule and trade-offs.
- Rank the provided stops in priority order based on the traveler's interests: "{trip.get('interests', 'General')}".
- If there is a delay or schedule overflow, explain why optional stops should be shortened or skipped before must-visit stops.

TRIP DATA:
Origin: {trip.get('origin')}
Destination: {trip.get('destination')}
Days: {trip.get('days')}
Start Time: {trip.get('startTime')}
Daily Hours Limit: {trip.get('dailyLimitHours')}
Interests: {trip.get('interests')}
Delay Lost Time: {delay_minutes} minutes
Schedule Overflow: {overflow}

STOPS:
{json.dumps(stops, indent=2)}

Return your answer strictly in JSON format with two keys:
{{
  "explanation": "Concise 2-3 sentence trade-off analysis strictly based on the provided stops and times.",
  "rankings": [
    {{
      "name": "Exact Stop Name from provided list",
      "priority": "High / Medium / Low",
      "reason": "Brief reason based on traveler interests and must-visit status"
    }}
  ]
}}
"""

    gemini_payload = {
        "contents": [{
            "parts": [{"text": prompt_content}]
        }],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.2
        }
    }

    # Try gemini-2.5-flash first, then gemini-1.5-flash
    models = ["gemini-2.5-flash", "gemini-1.5-flash"]
    last_error = None

    for model_name in models:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={gemini_key}"
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(gemini_payload).encode('utf-8'),
                headers={'Content-Type': 'application/json'},
                method='POST'
            )
            with urllib.request.urlopen(req, timeout=12) as response:
                result = json.loads(response.read().decode('utf-8'))
                text_response = result['candidates'][0]['content']['parts'][0]['text']
                parsed_json = json.loads(text_response)
                parsed_json['source'] = f'gemini ({model_name})'
                return jsonify(parsed_json)
        except Exception as e:
            last_error = str(e)
            continue

    # If Gemini API encountered an error (invalid key, network timeout), gracefully fall back
    fallback = generate_fallback_insights()
    fallback['source'] = 'heuristic_fallback_on_api_error'
    fallback['note'] = f"Gemini API request failed ({last_error}). Displaying local scheduling analysis."
    return jsonify(fallback)

# ----------------------------------------------------
# Route 4: Resilient Overpass API Proxy (Single-Endpoint + 1 Fallback)
# ----------------------------------------------------
@app.route('/api/overpass', methods=['POST'])
def proxy_overpass():
    body = request.get_json(silent=True) or {}
    query_data = body.get('data') or request.form.get('data') or ''
    if not query_data:
        return jsonify({'ok': False, 'error': 'Missing query data', 'statusCode': 400}), 400

    # Ordered mirrors: try primary first, fallback to backup if failed
    mirrors = [
        ('https://overpass-api.de/api/interpreter', 'primary'),
        ('https://lz4.overpass-api.de/api/interpreter', 'fallback')
    ]

    encoded_data = urllib.parse.urlencode({'data': query_data}).encode('utf-8')
    last_status = 502
    last_error_msg = None

    for idx, (endpoint, label) in enumerate(mirrors):
        # Wait briefly before attempting the fallback endpoint
        if idx > 0:
            time.sleep(1.2)

        try:
            req = urllib.request.Request(
                endpoint,
                data=encoded_data,
                headers={
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'TripMateApp/2.0 (CorridorSectionPOIFinder; contact: travel@tripmate.app)',
                    'Accept': 'application/json'
                }
            )
            with urllib.request.urlopen(req, timeout=14) as resp:
                resp_text = resp.read().decode('utf-8')
                try:
                    result = json.loads(resp_text)
                    return jsonify({
                        'ok': True,
                        'endpoint': endpoint,
                        'tier': label,
                        'elements': result.get('elements', [])
                    })
                except json.JSONDecodeError:
                    last_status = 502
                    last_error_msg = 'Invalid JSON response from Overpass interpreter'
                    continue

        except urllib.error.HTTPError as he:
            last_status = he.code
            if he.code == 429:
                last_error_msg = 'OpenStreetMap Overpass Rate Limit Exceeded (HTTP 429)'
            elif he.code in (504, 502, 503):
                last_error_msg = f'OpenStreetMap Overpass Gateway Timeout / Server Busy (HTTP {he.code})'
            else:
                last_error_msg = f'Overpass HTTP {he.code}: {he.reason}'
            # For 429, don't hammer the fallback immediately
            if he.code == 429:
                time.sleep(1.5)
            continue

        except (urllib.error.URLError, TimeoutError) as te:
            last_status = 504
            last_error_msg = 'Connection to Overpass timed out after 14s'
            continue

        except Exception as e:
            last_status = 500
            last_error_msg = str(e)
            continue

    return jsonify({
        'ok': False,
        'error': last_error_msg or 'Overpass service temporarily unavailable',
        'statusCode': last_status
    }), (last_status if 400 <= last_status <= 599 else 502)

# ----------------------------------------------------
# Route 5: Serve Static Files (CSS, JS, images)
# ----------------------------------------------------
@app.route('/<path:filename>')
def serve_static(filename):
    if filename.startswith('.') or filename == 'server.py' or filename.endswith('.env'):
        return "Access denied: This file is protected.", 403
    return send_from_directory('.', filename)

# ----------------------------------------------------
# Start Server
# ----------------------------------------------------
if __name__ == '__main__':
    print("====================================================")
    print(" TripMate AI Server is running!")
    print(" Open: http://127.0.0.1:5000")
    print("====================================================")
    app.run(host='127.0.0.1', port=5000, debug=True)
