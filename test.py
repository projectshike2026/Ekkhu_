import urllib.request
import json

req = urllib.request.Request('http://127.0.0.1:5000/chat', method='POST')
req.add_header('Content-Type', 'application/json')
data = json.dumps({'message': 'hi'}).encode('utf-8')

try:
    response = urllib.request.urlopen(req, data=data)
    print("Status:", response.status)
    print("Body:", response.read().decode('utf-8'))
except urllib.error.HTTPError as e:
    print("HTTPError:", e.code)
    print("Body:", e.read().decode('utf-8'))
except Exception as e:
    print("Error:", e)
