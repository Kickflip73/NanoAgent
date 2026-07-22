using System;
using System.Collections.Generic;
using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime
{
    public interface IDamageable
    {
        void TakeDamage(float amount, GameObject source);
    }

    public sealed class CombatSystem : MonoBehaviour
    {
        [SerializeField, Min(0f)]
        private float attackDamage = 1f;

        [SerializeField, Min(0f)]
        private float attackRadius = 1.5f;

        [SerializeField]
        private LayerMask damageableLayers = ~0;

        [SerializeField, Min(0f)]
        private float attackCooldown = 0.4f;

        private readonly HashSet<Component> hitDamageables = new HashSet<Component>();
        private float nextAttackTime;

        public event Action<GameObject> OnHit = delegate { };

        public void OnAttack()
        {
            OnAttack(transform.right);
        }

        public void OnAttack(Vector2 attackDirection)
        {
            if (Time.time < nextAttackTime)
            {
                return;
            }

            nextAttackTime = Time.time + attackCooldown;

            Vector2 direction = attackDirection.sqrMagnitude > 0f
                ? attackDirection.normalized
                : Vector2.right;
            Vector2 attackCenter = (Vector2)transform.position + direction * attackRadius;
            Collider2D[] hits = Physics2D.OverlapCircleAll(
                attackCenter,
                attackRadius,
                damageableLayers);

            hitDamageables.Clear();
            foreach (Collider2D hit in hits)
            {
                Component damageableComponent = hit.GetComponentInParent(typeof(IDamageable));
                if (damageableComponent == null
                    || damageableComponent.transform.root == transform.root
                    || !hitDamageables.Add(damageableComponent))
                {
                    continue;
                }

                IDamageable damageable = (IDamageable)damageableComponent;
                damageable.TakeDamage(attackDamage, gameObject);
                OnHit.Invoke(damageableComponent.gameObject);
            }
        }
    }
}
