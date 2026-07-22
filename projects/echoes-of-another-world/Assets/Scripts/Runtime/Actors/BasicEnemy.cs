using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime.Actors
{
    public enum EnemyState
    {
        Patrol,
        Chase
    }

    [RequireComponent(typeof(Rigidbody2D))]
    [RequireComponent(typeof(ActorHealth))]
    public sealed class BasicEnemy : MonoBehaviour
    {
        [SerializeField, Min(0f)]
        private float patrolSpeed = 1.2f;

        [SerializeField, Min(0f)]
        private float chaseSpeed = 2.4f;

        [SerializeField, Min(0f)]
        private float detectionRadius = 6f;

        [SerializeField, Min(0f)]
        private float contactDamage = 1f;

        private Rigidbody2D body;
        private Transform target;
        private Vector2 patrolOrigin;
        private Vector2 patrolDirection = Vector2.right;
        private float patrolTurnTime;
        private float slowMultiplier = 1f;
        private float slowUntil;
        private float nextContactDamageTime;

        public EnemyState State { get; private set; }

        private void Awake()
        {
            body = GetComponent<Rigidbody2D>();
            body.gravityScale = 0f;
            body.freezeRotation = true;
            patrolOrigin = transform.position;
        }

        public void Configure(Transform chaseTarget, float detection = 6f)
        {
            target = chaseTarget;
            detectionRadius = detection;
            patrolOrigin = transform.position;
        }

        public void ApplySlow(float multiplier, float duration)
        {
            slowMultiplier = Mathf.Clamp(multiplier, 0.1f, 1f);
            slowUntil = Mathf.Max(slowUntil, Time.time + Mathf.Max(0f, duration));
        }

        private void FixedUpdate()
        {
            if (target == null)
            {
                body.velocity = Vector2.zero;
                return;
            }

            float targetDistance = Vector2.Distance(body.position, target.position);
            State = targetDistance <= detectionRadius ? EnemyState.Chase : EnemyState.Patrol;
            float activeSlow = Time.time < slowUntil ? slowMultiplier : 1f;
            if (State == EnemyState.Chase)
            {
                Vector2 direction = ((Vector2)target.position - body.position).normalized;
                body.velocity = direction * chaseSpeed * activeSlow;
                return;
            }

            if (Time.time >= patrolTurnTime || Vector2.Distance(body.position, patrolOrigin) > 2.5f)
            {
                patrolDirection = Random.insideUnitCircle.normalized;
                patrolTurnTime = Time.time + Random.Range(1.5f, 3.5f);
            }

            body.velocity = patrolDirection * patrolSpeed * activeSlow;
        }

        private void OnCollisionStay2D(Collision2D collision)
        {
            if (Time.time < nextContactDamageTime || !collision.gameObject.CompareTag("Player"))
            {
                return;
            }

            IDamageable damageable = collision.gameObject.GetComponent<IDamageable>();
            if (damageable == null)
            {
                return;
            }

            nextContactDamageTime = Time.time + 1f;
            damageable.TakeDamage(contactDamage, gameObject);
        }
    }
}
