import requests
import json

response = requests.post(
  url="https://openrouter.ai/api/alpha/decisions",
  headers={
    "Authorization": "Bearer ****",
    "Content-Type": "application/json",
  },
  data=json.dumps({
    "model": "typesafe/jev-1.13",
    "state": "Help! My payouts have been failing for 3 days.",
    "questions": {
      "is_urgent": {
        "type": "noul",
        "instructions": "Does this message convey urgency?",
        "criteria": {
          "true": "Explicitly time-sensitive",
          "false": "No urgency expressed"
        }
      },
      "department": {
        "type": "choice",
        "instructions": "Which team should handle this?",
        "criteria": {
          "billing": "Payments, invoicing, refunds",
          "technical": "Bugs, outages, integrations",
          "sales": "Pricing, upgrades, new accounts"
        }
      },
      "frustration": {
        "type": "score",
        "instructions": "How frustrated is the customer?",
        "criteria": ["Calm", "Frustrated", "Very angry"]
      }
    }
  })
)

answers = response.json()["answers"]
# noul is a probability from 0 (no) to 1 (yes); choice and score carry the full distribution.
print(answers["is_urgent"]["noul"])
print(answers["department"]["choice"], answers["department"]["probabilities"])
print(answers["frustration"]["score"])

if answers["is_urgent"]["noul"] > 0.8 and answers["department"]["choice"] == "billing":
  pass