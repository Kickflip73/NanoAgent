using System;

namespace EchoesOfAnotherWorld.Runtime.Save
{
    [Serializable]
    public sealed class SaveData
    {
        public int version = 1;
        public float playerX;
        public float playerY;
        public float playerHealth;
        public string[] equippedEchoIds = Array.Empty<string>();
        public int selectedEchoSlot;
        public int wantedLevel;
    }
}
