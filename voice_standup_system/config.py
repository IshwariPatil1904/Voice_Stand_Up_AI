from pymongo import MongoClient

# Connect to local MongoDB
client = MongoClient("mongodb://localhost:27017/")

# Create / connect database
db = client["voice_standup_db"]

print("MongoDB Connected Successfully!")