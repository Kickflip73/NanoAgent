using System;
using UnityEngine;
using UnityEngine.InputSystem;

namespace EchoesOfAnotherWorld.Runtime.Input
{
    public sealed class PlayerInput : MonoBehaviour
    {
        private InputActionMap playerActionMap;
        private InputAction moveAction;
        private InputAction attackAction;
        private InputAction dodgeAction;
        private InputAction skillAction;
        private InputAction interactAction;
        private InputAction nextEchoAction;

        public event Action AttackPressed = delegate { };
        public event Action DodgePressed = delegate { };
        public event Action SkillPressed = delegate { };
        public event Action InteractPressed = delegate { };
        public event Action NextEchoPressed = delegate { };

        public Vector2 MoveDirection => moveAction.ReadValue<Vector2>();

        public bool AttackPressedThisFrame => attackAction.WasPressedThisFrame();

        public bool DodgePressedThisFrame => dodgeAction.WasPressedThisFrame();

        public bool SkillPressedThisFrame => skillAction.WasPressedThisFrame();

        private void Awake()
        {
            playerActionMap = new InputActionMap("Player");

            moveAction = playerActionMap.AddAction(
                "Move",
                InputActionType.Value,
                expectedControlType: "Vector2");
            moveAction.AddCompositeBinding("2DVector")
                .With("Up", "<Keyboard>/w")
                .With("Down", "<Keyboard>/s")
                .With("Left", "<Keyboard>/a")
                .With("Right", "<Keyboard>/d");
            moveAction.AddBinding("<Gamepad>/leftStick");

            attackAction = playerActionMap.AddAction("Attack", InputActionType.Button);
            attackAction.AddBinding("<Mouse>/leftButton");
            attackAction.AddBinding("<Keyboard>/j");
            attackAction.AddBinding("<Gamepad>/buttonSouth");

            dodgeAction = playerActionMap.AddAction("Dodge", InputActionType.Button);
            dodgeAction.AddBinding("<Keyboard>/space");
            dodgeAction.AddBinding("<Keyboard>/leftShift");
            dodgeAction.AddBinding("<Gamepad>/buttonEast");

            skillAction = playerActionMap.AddAction("Skill", InputActionType.Button);
            skillAction.AddBinding("<Keyboard>/e");
            skillAction.AddBinding("<Gamepad>/buttonWest");

            interactAction = playerActionMap.AddAction("Interact", InputActionType.Button);
            interactAction.AddBinding("<Keyboard>/f");
            interactAction.AddBinding("<Gamepad>/rightShoulder");

            nextEchoAction = playerActionMap.AddAction("NextEcho", InputActionType.Button);
            nextEchoAction.AddBinding("<Keyboard>/q");
            nextEchoAction.AddBinding("<Gamepad>/leftShoulder");

            attackAction.performed += OnAttackPerformed;
            dodgeAction.performed += OnDodgePerformed;
            skillAction.performed += OnSkillPerformed;
            interactAction.performed += OnInteractPerformed;
            nextEchoAction.performed += OnNextEchoPerformed;
        }

        private void OnEnable()
        {
            playerActionMap.Enable();
        }

        private void OnDisable()
        {
            playerActionMap.Disable();
        }

        private void OnDestroy()
        {
            attackAction.performed -= OnAttackPerformed;
            dodgeAction.performed -= OnDodgePerformed;
            skillAction.performed -= OnSkillPerformed;
            interactAction.performed -= OnInteractPerformed;
            nextEchoAction.performed -= OnNextEchoPerformed;
        }

        private void OnAttackPerformed(InputAction.CallbackContext context)
        {
            AttackPressed.Invoke();
        }

        private void OnDodgePerformed(InputAction.CallbackContext context)
        {
            DodgePressed.Invoke();
        }

        private void OnSkillPerformed(InputAction.CallbackContext context)
        {
            SkillPressed.Invoke();
        }

        private void OnInteractPerformed(InputAction.CallbackContext context)
        {
            InteractPressed.Invoke();
        }

        private void OnNextEchoPerformed(InputAction.CallbackContext context)
        {
            NextEchoPressed.Invoke();
        }
    }
}
