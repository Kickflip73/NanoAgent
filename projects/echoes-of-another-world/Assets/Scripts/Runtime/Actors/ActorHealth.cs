using System;
using EchoesOfAnotherWorld.Runtime.Events;
using EchoesOfAnotherWorld.Runtime.Wanted;
using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime.Actors
{
    public enum ActorDisposition
    {
        Player,
        Hostile,
        Civilian,
        Guard
    }

    public sealed class ActorHealth : MonoBehaviour, IDamageable
    {
        [SerializeField, Min(1f)]
        private float maximumHealth = 5f;

        [SerializeField]
        private ActorDisposition disposition = ActorDisposition.Hostile;

        [SerializeField]
        private bool destroyOnDeath = true;

        private FloatEventChannel healthChanged;
        private WantedSystem wantedSystem;

        public event Action<ActorHealth> Died = delegate { };

        public float CurrentHealth { get; private set; }

        public float MaximumHealth => maximumHealth;

        public ActorDisposition Disposition => disposition;

        public bool IsDead => CurrentHealth <= 0f;

        private void Awake()
        {
            CurrentHealth = maximumHealth;
        }

        public void Configure(
            float maxHealth,
            ActorDisposition actorDisposition,
            bool shouldDestroyOnDeath,
            FloatEventChannel changedChannel = null,
            WantedSystem wanted = null)
        {
            maximumHealth = Mathf.Max(1f, maxHealth);
            CurrentHealth = maximumHealth;
            disposition = actorDisposition;
            destroyOnDeath = shouldDestroyOnDeath;
            healthChanged = changedChannel;
            wantedSystem = wanted;
            PublishHealth();
        }

        public void TakeDamage(float amount, GameObject source)
        {
            if (IsDead || amount <= 0f)
            {
                return;
            }

            DodgeSystem dodge = GetComponent<DodgeSystem>();
            if (dodge != null && dodge.IsInvincible)
            {
                return;
            }

            if (source != null && source.CompareTag("Player") && wantedSystem != null)
            {
                if (disposition == ActorDisposition.Civilian)
                {
                    wantedSystem.ReportCrime(CrimeType.AttackCivilian);
                }
                else if (disposition == ActorDisposition.Guard)
                {
                    wantedSystem.ReportCrime(CrimeType.AttackGuard);
                }
            }

            CurrentHealth = Mathf.Max(0f, CurrentHealth - amount);
            PublishHealth();
            if (!IsDead)
            {
                return;
            }

            Died.Invoke(this);
            if (destroyOnDeath)
            {
                Destroy(gameObject);
            }
        }

        public void SetCurrentHealth(float value)
        {
            CurrentHealth = Mathf.Clamp(value, 0f, maximumHealth);
            PublishHealth();
        }

        private void PublishHealth()
        {
            healthChanged?.Raise(maximumHealth <= 0f ? 0f : CurrentHealth / maximumHealth);
        }
    }
}
