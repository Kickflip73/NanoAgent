using EchoesOfAnotherWorld.Runtime.Events;
using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime.Wanted
{
    public enum CrimeType
    {
        AttackCivilian,
        AttackGuard
    }

    public sealed class WantedSystem : MonoBehaviour
    {
        private IntEventChannel wantedLevelChanged;
        private int crimePoints;

        public int Level { get; private set; }

        public void Configure(IntEventChannel changedChannel)
        {
            wantedLevelChanged = changedChannel;
            wantedLevelChanged?.Raise(Level);
        }

        public void ReportCrime(CrimeType crime)
        {
            crimePoints += crime == CrimeType.AttackGuard ? 2 : 1;
            SetLevel(Mathf.Clamp(crimePoints, 0, 3));
        }

        public void SetLevel(int level)
        {
            int clampedLevel = Mathf.Clamp(level, 0, 3);
            crimePoints = clampedLevel;
            if (Level == clampedLevel)
            {
                wantedLevelChanged?.Raise(Level);
                return;
            }

            Level = clampedLevel;
            wantedLevelChanged?.Raise(Level);
        }
    }
}
